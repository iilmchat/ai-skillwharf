import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AIMessage,
  type BaseMessage,
  ToolMessage,
  type ToolCall,
} from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import {
  Annotation,
  END,
  getWriter,
  START,
  StateGraph,
} from '@langchain/langgraph';
import type { InstalledSkill } from '@prisma/client';
import { SkillManifestSchema } from '@skillwharf/shared';
import { randomUUID } from 'node:crypto';
import { BillingService } from '../billing/billing.service.js';
import { ERROR_KEYS } from '../i18n/error-keys.js';
import {
  AUDIT_FRAUD_RISK_TOOL_NAME,
  CALCULATE_UNIT_ECONOMICS_TOOL_NAME,
  CHECK_FACTS_TOOL_NAME,
  DETECT_PROFIT_LEAKS_TOOL_NAME,
  EXEC_TOOL_NAME,
  EXTRACT_DOCUMENT_DATA_TOOL_NAME,
  GENERATE_IMAGE_TOOL_NAME,
  GOOGLE_DOCS_CREATE_TOOL_NAME,
  GOOGLE_SHEETS_APPEND_TOOL_NAME,
  LlmService,
  MONITOR_COMPETITOR_PRICES_TOOL_NAME,
  OZON_MCP_TOOL_NAME,
  PUBLISH_TO_DZEN_TOOL_NAME,
  RUN_WORKFLOW_TOOL_NAME,
  SANDBOX_TOOL_NAME,
  SCREEN_RESUME_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  WB_MCP_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  messageContentToText,
  toLangChainMessage,
  type SandboxToolOptions,
} from '../llm/llm.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AgentGatewayService } from '../security/agent-gateway.service.js';
import { SkillsService } from '../skills/skills.service.js';
import {
  LlmRouterService,
  type LlmRouteSelection,
} from '../llm-router/llm-router.service.js';
import {
  DEFAULT_OFFICE_AGENT_ID,
  OFFICE_TASKS,
  officeTaskForTool,
  type ChatOfficeEvent,
  type OfficeEvent,
} from './office-events.js';

/** Сколько последних сообщений диалога передаём в LLM. */
export const CHAT_HISTORY_LIMIT = 10;

/** Сколько раз за один ответ разрешено запускать инструменты. */
export const MAX_TOOL_ROUNDS = 5;

/** Минимальный баланс, с которым разрешено запускать агента. */
export const MIN_AGENT_BALANCE = 0.5;

const TOOL_LIMIT_REPLY =
  'Достигнут лимит вызовов инструментов. Уточните запрос и попробуйте снова.';

const DEFAULT_CONVERSATION_TITLE = 'Новый диалог';

const ChatStateAnnotation = Annotation.Root({
  conversationId: Annotation<string>({
    reducer: (_previous, next) => next,
    default: () => '',
  }),
  userId: Annotation<string>({
    reducer: (_previous, next) => next,
    default: () => '',
  }),
  messages: Annotation<BaseMessage[]>({
    reducer: (_previous, next) => next,
    default: () => [],
  }),
  reply: Annotation<string>({
    reducer: (_previous, next) => next,
    default: () => '',
  }),
  availableTools: Annotation<StructuredToolInterface[]>({
    reducer: (_previous, next) => next,
    default: () => [],
  }),
  /** Инструменты, которые нельзя запускать без подтверждения пользователя. */
  approvalRequiredTools: Annotation<string[]>({
    reducer: (_previous, next) => next,
    default: () => [],
  }),
  /** Маршрут LLM, выбранный роутером перед запуском графа. */
  llmRoute: Annotation<LlmRouteSelection | null>({
    reducer: (_previous, next) => next,
    default: () => null,
  }),
  /** Цены Pay-per-Outcome по именам инструментов. */
  outcomePrices: Annotation<Record<string, OutcomePrice>>({
    reducer: (_previous, next) => next,
    default: () => ({}),
  }),
});

type ChatState = typeof ChatStateAnnotation.State;

export interface ChatReply {
  conversationId: string;
  reply: string;
}

/** Событие чанка текста, которое граф отдаёт в custom-стрим. */
export interface ChatStreamDelta {
  type: 'delta';
  text: string;
}

/** Все события, которые граф отдаёт в custom-стрим. */
export type ChatStreamEvent = ChatStreamDelta | ChatOfficeEvent;

interface ToolPrice {
  price: number;
  skillName: string;
  freeCallsLimit: number;
}

/** Цена Pay-per-Outcome для инструмента. */
export interface OutcomePrice {
  price: number;
  skillName: string;
}

/**
 * Цена инструмента берётся из манифеста включённого навыка, который объявил
 * этот инструмент в `dependencies.tools`. Поддерживаются Pay-per-Call и
 * Freemium (с бесплатными вызовами); Free и отсутствие цены — бесплатно.
 */
function resolveToolPrice(
  skills: InstalledSkill[],
  toolName: string,
): ToolPrice | null {
  for (const skill of skills) {
    const parsed = SkillManifestSchema.safeParse(skill.manifest);

    if (!parsed.success) {
      continue;
    }

    const manifest = parsed.data;

    if (!manifest.dependencies?.tools?.includes(toolName)) {
      continue;
    }

    const pricing = manifest.pricing;

    if (
      !pricing ||
      typeof pricing.price !== 'number' ||
      pricing.price <= 0 ||
      (pricing.model !== 'Pay-per-Call' && pricing.model !== 'Freemium')
    ) {
      return null;
    }

    return {
      price: pricing.price,
      skillName: manifest.name,
      freeCallsLimit: pricing.freeCallsLimit ?? 0,
    };
  }

  return null;
}

/**
 * Инструменты, для которых включённый навык требует подтверждения. Поле
 * `requiresApproval` живёт в манифесте навыка и распространяется на все
 * инструменты из его `dependencies.tools`.
 */
function resolveApprovalTools(skills: InstalledSkill[]): string[] {
  const tools = new Set<string>();

  for (const skill of skills) {
    const parsed = SkillManifestSchema.safeParse(skill.manifest);

    if (!parsed.success || parsed.data.requiresApproval !== true) {
      continue;
    }

    for (const tool of parsed.data.dependencies?.tools ?? []) {
      tools.add(tool);
    }
  }

  return [...tools];
}

/** Объявлен ли инструмент хотя бы одним включённым навыком. */
function skillDeclaresTool(
  skills: InstalledSkill[],
  toolName: string,
): boolean {
  return skills.some((skill) => {
    const parsed = SkillManifestSchema.safeParse(skill.manifest);

    return (
      parsed.success &&
      (parsed.data.dependencies?.tools?.includes(toolName) ?? false)
    );
  });
}

/** Цены Pay-per-Outcome по инструментам из манифестов навыков. */
function resolveOutcomePrices(
  skills: InstalledSkill[],
): Record<string, OutcomePrice> {
  const prices: Record<string, OutcomePrice> = {};

  for (const skill of skills) {
    const parsed = SkillManifestSchema.safeParse(skill.manifest);

    if (!parsed.success) {
      continue;
    }

    const pricing = parsed.data.pricing;

    if (
      pricing?.model !== 'Pay-per-Outcome' ||
      typeof pricing.price !== 'number' ||
      pricing.price <= 0
    ) {
      continue;
    }

    for (const tool of parsed.data.dependencies?.tools ?? []) {
      prices[tool] = { price: pricing.price, skillName: parsed.data.name };
    }
  }

  return prices;
}

function lastMessage(messages: BaseMessage[]): BaseMessage | undefined {
  return messages[messages.length - 1];
}

/** `tool_calls` последнего сообщения, если это ответ модели. */
function toolCallsOf(message: BaseMessage | undefined): ToolCall[] {
  return message instanceof AIMessage ? (message.tool_calls ?? []) : [];
}

/** Сколько раундов вызова инструментов уже завершено в истории. */
function toolRounds(messages: BaseMessage[]): number {
  return messages.filter((message) => toolCallsOf(message).length > 0).length;
}

interface EscrowHold {
  entryId: string;
}

interface ToolExecutionOptions {
  userId: string;
  outcomePrices: Record<string, OutcomePrice>;
  preAuthorizedHolds: Map<number, EscrowHold>;
  billingService: BillingService;
  agentGateway: AgentGatewayService;
}

/**
 * Выполняет `tool_calls` текущего ответа модели с runtime-политиками:
 * Agent Gateway проверяет аргументы, Pay-per-Outcome инструменты проходят
 * через hold → capture/cancel. Ошибки инструмента пробрасываются наружу.
 */
async function executeToolCalls(
  tools: StructuredToolInterface[],
  calls: ToolCall[],
  options: ToolExecutionOptions,
): Promise<ToolMessage[]> {
  return Promise.all(
    calls.map(async (call, index) => {
      const tool = tools.find((candidate) => candidate.name === call.name);

      if (!tool) {
        return new ToolMessage({
          tool_call_id: call.id ?? '',
          name: call.name,
          content: `Инструмент «${call.name}» не найден`,
          status: 'error',
        });
      }

      const args = options.agentGateway.validateToolCall(call.name, call.args);
      const outcome = options.outcomePrices[call.name];
      let hold = options.preAuthorizedHolds.get(index);

      if (!hold && outcome) {
        const authorized = await options.billingService.authorizeHold(
          options.userId,
          outcome.price,
          randomUUID(),
        );
        hold = { entryId: authorized.entryId };
      }

      let result: unknown;

      try {
        result = await tool.invoke(args);
      } catch (error) {
        if (hold) {
          await options.billingService.cancelHold(hold.entryId);
        }

        throw error;
      }

      if (hold) {
        await options.billingService.captureHold(hold.entryId);
      }

      return new ToolMessage({
        tool_call_id: call.id ?? '',
        name: call.name,
        content: typeof result === 'string' ? result : JSON.stringify(result),
      });
    }),
  );
}

/**
 * Колбэк ожидания подтверждения. Возвращает промис, который резолвится,
 * когда пользователь пришлёт `approve_action` для этого диалога.
 */
type ApprovalGate = (conversationId: string, userId: string) => Promise<void>;

/**
 * Граф состояний LangGraph в стиле AgentExecutor:
 *
 * `llm` → (есть tool_calls?) → `tools` → `llm` → … → END.
 *
 * Инструменты приходят в состоянии, потому что содержат привязанный к
 * пользователю paywall-хук.
 */
function buildChatGraph(
  llmService: LlmService,
  waitForApproval: ApprovalGate,
  billingService: BillingService,
  agentGateway: AgentGatewayService,
) {
  return new StateGraph(ChatStateAnnotation)
    .addNode('llm', async (state: ChatState, config) => {
      const emit = getWriter(config);
      let text = '';
      let response: AIMessage | undefined;

      for await (const chunk of llmService.chatWithToolsStream(
        state.messages,
        state.availableTools,
        state.llmRoute ?? undefined,
        { userId: state.userId },
      )) {
        if (chunk.type === 'delta') {
          text += chunk.text;
          emit?.({ type: 'delta', text: chunk.text } satisfies ChatStreamDelta);
        } else {
          response = chunk.message;
        }
      }

      if (!response) {
        throw new Error('LLM не вернул финальное сообщение');
      }

      const calls = response.tool_calls ?? [];
      const limitReached = toolRounds(state.messages) >= MAX_TOOL_ROUNDS;
      const answer = text || messageContentToText(response.content);
      const reply =
        calls.length > 0 && !limitReached
          ? ''
          : answer || (limitReached ? TOOL_LIMIT_REPLY : '');

      // Служебный ответ (например, лимит инструментов) тоже должен дойти
      // до клиента, хотя модель его не генерировала.
      if (reply && reply !== text) {
        emit?.({ type: 'delta', text: reply } satisfies ChatStreamDelta);
      }

      return {
        messages: [...state.messages, response],
        reply,
      };
    })
    .addNode('tools', async (state: ChatState, config) => {
      const emit = getWriter(config);
      const calls = toolCallsOf(lastMessage(state.messages));
      const approvalRequired = new Set(state.approvalRequiredTools);
      const approvalCalls = calls.filter((call) =>
        approvalRequired.has(call.name),
      );
      const preAuthorizedHolds = new Map<number, EscrowHold>();

      if (approvalCalls.length > 0) {
        // Сначала валидируем все approval-вызовы, чтобы не зарезервировать
        // деньги под действие, которое всё равно заблокирует политика.
        for (const call of approvalCalls) {
          agentGateway.validateToolCall(call.name, call.args);
        }

        const createdHolds: EscrowHold[] = [];

        try {
          // Pay-per-Outcome резервируется до ожидания одобрения и остаётся
          // PENDING, пока пользователь не подтвердит действие.
          for (const [index, call] of calls.entries()) {
            if (!approvalRequired.has(call.name)) {
              continue;
            }

            const outcome = state.outcomePrices[call.name];

            if (!outcome) {
              continue;
            }

            const authorized = await billingService.authorizeHold(
              state.userId,
              outcome.price,
              randomUUID(),
            );
            const hold = { entryId: authorized.entryId };

            preAuthorizedHolds.set(index, hold);
            createdHolds.push(hold);
          }
        } catch (error) {
          await Promise.all(
            createdHolds.map((hold) => billingService.cancelHold(hold.entryId)),
          );
          throw error;
        }

        // Ставим промис в Map до отправки события, чтобы approve_action
        // не мог прийти раньше, чем сохранено состояние ожидания.
        const approved = waitForApproval(state.conversationId, state.userId);
        const reason = approvalCalls.some((call) =>
          Boolean(state.outcomePrices[call.name]),
        )
          ? ('payment' as const)
          : ('approval' as const);

        emit?.({
          type: 'office',
          conversationId: state.conversationId,
          agentId: DEFAULT_OFFICE_AGENT_ID,
          status: 'waiting_approval',
          task: `${OFFICE_TASKS.waitingApproval}: ${officeTaskForTool(approvalCalls[0]?.name ?? '')}`,
          reason,
        } satisfies ChatOfficeEvent);

        await approved;
      } else {
        // AI-Офис получает задачу по имени каждого инструмента, который
        // запросила модель. События уходят до фактического запуска.
        for (const call of calls) {
          emit?.({
            type: 'office',
            conversationId: state.conversationId,
            agentId: DEFAULT_OFFICE_AGENT_ID,
            status: 'working',
            task: officeTaskForTool(call.name),
          } satisfies ChatOfficeEvent);
        }
      }

      return {
        messages: [
          ...state.messages,
          ...(await executeToolCalls(state.availableTools, calls, {
            userId: state.userId,
            outcomePrices: state.outcomePrices,
            preAuthorizedHolds,
            billingService,
            agentGateway,
          })),
        ],
      };
    })
    .addEdge(START, 'llm')
    .addConditionalEdges('llm', (state: ChatState) => {
      if (toolCallsOf(lastMessage(state.messages)).length === 0) {
        return END;
      }

      // Защита от бесконечного цикла «модель просит инструмент снова».
      return toolRounds(state.messages) > MAX_TOOL_ROUNDS ? END : 'tools';
    })
    .addEdge('tools', 'llm')
    .compile();
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private readonly graph: ReturnType<typeof buildChatGraph>;
  /**
   * Ожидающие одобрения диалоги: ключ — `conversationId`, значение —
   * владелец диалога и функция, которая будит граф.
   */
  private readonly pendingApprovals = new Map<
    string,
    { userId: string; resume: () => void }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly llmService: LlmService,
    private readonly billingService: BillingService,
    private readonly skillsService: SkillsService,
    private readonly llmRouterService: LlmRouterService,
    private readonly agentGateway: AgentGatewayService,
  ) {
    this.graph = buildChatGraph(
      this.llmService,
      (conversationId, userId) => this.waitForApproval(conversationId, userId),
      this.billingService,
      this.agentGateway,
    );
  }

  /**
   * Возобновляет граф, приостановленный перед инструментом, которому нужно
   * одобрение. Возвращает `false`, если ожидания для диалога нет или оно
   * принадлежит другому пользователю.
   */
  approveAction(conversationId: string, userId: string): boolean {
    const pending = this.pendingApprovals.get(conversationId);

    if (!pending || pending.userId !== userId) {
      return false;
    }

    this.pendingApprovals.delete(conversationId);
    pending.resume();

    return true;
  }

  async createConversation(
    userId: string,
    title?: string,
  ): Promise<{ id: string }> {
    return this.prisma.conversation.create({
      data: {
        userId,
        title: title?.trim() || DEFAULT_CONVERSATION_TITLE,
      },
      select: { id: true },
    });
  }

  async handleMessage(
    userId: string,
    conversationId: string,
    content: string,
  ): Promise<ChatReply> {
    this.logAgentContext(userId, conversationId);

    const { messages, tools, approvalRequiredTools, outcomePrices } =
      await this.prepareMessage(userId, conversationId, content);
    const llmRoute = await this.llmRouterService.selectRoute();

    let reply: string;

    try {
      const state = await this.graph.invoke({
        conversationId,
        userId,
        messages,
        availableTools: tools,
        approvalRequiredTools,
        outcomePrices,
        llmRoute,
      });
      reply = state.reply;
    } catch (error) {
      // Paywall: списание не удалось — песочница не запускалась,
      // прерываем граф и отдаём клиенту ключ ошибки для перевода.
      if (!(error instanceof BadRequestException)) {
        throw error;
      }

      reply = ERROR_KEYS.insufficientFunds;
    } finally {
      this.pendingApprovals.delete(conversationId);
    }

    await this.persistReply(conversationId, reply);

    return { conversationId, reply };
  }

  /**
   * Стриминговый ответ: граф запускается в режиме `custom`, а каждый
   * сгенерированный фрагмент текста уходит в `onDelta`. Полный ответ
   * сохраняется в БД после завершения стрима.
   */
  async streamMessage(
    userId: string,
    conversationId: string,
    content: string,
    onDelta: (text: string) => void,
    onOfficeEvent?: (event: OfficeEvent) => void,
  ): Promise<ChatReply> {
    this.logAgentContext(userId, conversationId);

    const { messages, tools, approvalRequiredTools, outcomePrices } =
      await this.prepareMessage(userId, conversationId, content);
    const llmRoute = await this.llmRouterService.selectRoute();

    let reply = '';

    try {
      const stream = await this.graph.stream(
        {
          conversationId,
          userId,
          messages,
          availableTools: tools,
          approvalRequiredTools,
          outcomePrices,
          llmRoute,
        },
        { streamMode: ['custom', 'values'] },
      );

      for await (const event of stream) {
        const [mode, chunk] = event as [string, unknown];

        if (mode === 'custom') {
          const event = chunk as Partial<ChatStreamEvent>;

          if (event.type === 'delta' && typeof event.text === 'string') {
            onDelta(event.text);
          } else if (event.type === 'office') {
            const officeEvent = event as ChatOfficeEvent;

            if (
              typeof officeEvent.agentId === 'string' &&
              (officeEvent.status === 'working' ||
                officeEvent.status === 'waiting_approval') &&
              typeof officeEvent.task === 'string'
            ) {
              onOfficeEvent?.({
                // Контекст диалога берём из аргумента метода: событие
                // инструмента не должно потерять привязку к чату.
                conversationId,
                agentId: officeEvent.agentId,
                status: officeEvent.status,
                task: officeEvent.task,
                ...(officeEvent.reason === 'approval' ||
                officeEvent.reason === 'payment'
                  ? { reason: officeEvent.reason }
                  : {}),
              });
            }
          }
        } else if (mode === 'values') {
          reply = (chunk as ChatState).reply;
        }
      }
    } catch (error) {
      if (!(error instanceof BadRequestException)) {
        throw error;
      }

      reply = ERROR_KEYS.insufficientFunds;
      onDelta(reply);
    } finally {
      // Диалог завершился (в том числе с ошибкой) — ожидание больше не нужно.
      this.pendingApprovals.delete(conversationId);
    }

    await this.persistReply(conversationId, reply);

    return { conversationId, reply };
  }

  /** Проверяет диалог, баланс, сохраняет вопрос и собирает контекст. */
  private async prepareMessage(
    userId: string,
    conversationId: string,
    content: string,
  ): Promise<{
    messages: BaseMessage[];
    tools: StructuredToolInterface[];
    approvalRequiredTools: string[];
    outcomePrices: Record<string, OutcomePrice>;
  }> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { id: true, userId: true },
    });

    if (!conversation) {
      throw new NotFoundException(`Диалог ${conversationId} не найден`);
    }

    if (conversation.userId !== userId) {
      throw new ForbiddenException('Диалог принадлежит другому пользователю');
    }

    // Cost control: не запускаем даже LLM, если на счету меньше порога.
    await this.assertSufficientBalance(userId);

    await this.prisma.message.create({
      data: { conversationId, role: 'user', content },
    });

    const latestMessages = await this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      take: CHAT_HISTORY_LIMIT,
      select: { role: true, content: true },
    });

    const messages = latestMessages
      .reverse()
      .map((message) => toLangChainMessage(message));

    const skills = await this.skillsService.getEnabledSkills();
    const tools = this.buildTools(userId, skills);
    const approvalRequiredTools = resolveApprovalTools(skills);
    const outcomePrices = resolveOutcomePrices(skills);

    return { messages, tools, approvalRequiredTools, outcomePrices };
  }

  /** Сохраняет ответ ассистента и обновляет время диалога. */
  private async persistReply(
    conversationId: string,
    reply: string,
  ): Promise<void> {
    await this.prisma.message.create({
      data: { conversationId, role: 'assistant', content: reply },
    });
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });
  }

  /** Проверяет минимальный баланс перед запуском графа. */
  private async assertSufficientBalance(userId: string): Promise<void> {
    const { balance } = await this.billingService.getBalance(userId);

    if (Number.parseFloat(balance) < MIN_AGENT_BALANCE) {
      throw new BadRequestException(ERROR_KEYS.insufficientFunds);
    }
  }

  /** Сохраняет резолвер в Map и возвращает промис ожидания одобрения. */
  private waitForApproval(
    conversationId: string,
    userId: string,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      this.pendingApprovals.set(conversationId, { userId, resume: resolve });
    });
  }

  /**
   * OTel-атрибуты запуска агента: агент и tenant (владелец диалога).
   * Пишем JSON в лог приложения, чтобы позже подключить OTLP-экспорт.
   */
  private logAgentContext(userId: string, conversationId: string): void {
    this.logger.log(
      JSON.stringify({
        event: 'gen_ai.agent.run',
        'gen_ai.agent.id': DEFAULT_OFFICE_AGENT_ID,
        'gen_ai.tenant.id': userId,
        conversationId,
      }),
    );
  }

  /**
   * Инструменты, доступные агенту. Цена каждого берётся из манифеста
   * включённого навыка, объявившего инструмент; если цены нет — бесплатно.
   */
  private buildTools(
    userId: string,
    skills: InstalledSkill[],
  ): StructuredToolInterface[] {
    const beforeExecuteFor = (
      toolName: string,
    ): SandboxToolOptions['beforeExecute'] => {
      const pricing = resolveToolPrice(skills, toolName);

      if (!pricing) {
        return undefined;
      }

      return async (): Promise<void> => {
        await this.billingService.checkAndChargeSkill(
          userId,
          pricing.skillName,
          pricing.price,
          pricing.freeCallsLimit,
        );
      };
    };

    const tools: StructuredToolInterface[] = [
      this.llmService.createSandboxTool({
        beforeExecute: beforeExecuteFor(SANDBOX_TOOL_NAME),
      }),
      this.llmService.createWebSearchTool({
        beforeExecute: beforeExecuteFor(WEB_SEARCH_TOOL_NAME),
      }),
      this.llmService.createExecTool({
        beforeExecute: beforeExecuteFor(EXEC_TOOL_NAME),
      }),
    ];

    // Marketplace-инструменты подключаются только если их объявил
    // установленный и включённый навык (ozon-seller / wb-seller).
    if (skillDeclaresTool(skills, OZON_MCP_TOOL_NAME)) {
      tools.push(
        this.llmService.createOzonMcpTool({
          beforeExecute: beforeExecuteFor(OZON_MCP_TOOL_NAME),
        }),
      );
    }

    if (skillDeclaresTool(skills, WB_MCP_TOOL_NAME)) {
      tools.push(
        this.llmService.createWbMcpTool({
          beforeExecute: beforeExecuteFor(WB_MCP_TOOL_NAME),
        }),
      );
    }

    if (skillDeclaresTool(skills, SEND_MESSAGE_TOOL_NAME)) {
      tools.push(
        this.llmService.createSendMessageTool({
          beforeExecute: beforeExecuteFor(SEND_MESSAGE_TOOL_NAME),
        }),
      );
    }

    if (skillDeclaresTool(skills, GOOGLE_SHEETS_APPEND_TOOL_NAME)) {
      tools.push(
        this.llmService.createGoogleSheetsAppendTool({
          beforeExecute: beforeExecuteFor(GOOGLE_SHEETS_APPEND_TOOL_NAME),
        }),
      );
    }

    if (skillDeclaresTool(skills, GOOGLE_DOCS_CREATE_TOOL_NAME)) {
      tools.push(
        this.llmService.createGoogleDocsCreateTool({
          beforeExecute: beforeExecuteFor(GOOGLE_DOCS_CREATE_TOOL_NAME),
        }),
      );
    }

    if (skillDeclaresTool(skills, GENERATE_IMAGE_TOOL_NAME)) {
      tools.push(
        this.llmService.createGenerateImageTool({
          beforeExecute: beforeExecuteFor(GENERATE_IMAGE_TOOL_NAME),
        }),
      );
    }

    if (skillDeclaresTool(skills, RUN_WORKFLOW_TOOL_NAME)) {
      tools.push(
        this.llmService.createRunWorkflowTool({
          beforeExecute: beforeExecuteFor(RUN_WORKFLOW_TOOL_NAME),
        }),
      );
    }

    if (skillDeclaresTool(skills, PUBLISH_TO_DZEN_TOOL_NAME)) {
      tools.push(
        this.llmService.createPublishToDzenTool({
          beforeExecute: beforeExecuteFor(PUBLISH_TO_DZEN_TOOL_NAME),
        }),
      );
    }

    if (skillDeclaresTool(skills, CHECK_FACTS_TOOL_NAME)) {
      tools.push(
        this.llmService.createCheckFactsTool({
          beforeExecute: beforeExecuteFor(CHECK_FACTS_TOOL_NAME),
        }),
      );
    }

    if (skillDeclaresTool(skills, SCREEN_RESUME_TOOL_NAME)) {
      tools.push(
        this.llmService.createScreenResumeTool({
          beforeExecute: beforeExecuteFor(SCREEN_RESUME_TOOL_NAME),
        }),
      );
    }

    if (skillDeclaresTool(skills, EXTRACT_DOCUMENT_DATA_TOOL_NAME)) {
      tools.push(
        this.llmService.createExtractDocumentDataTool({
          beforeExecute: beforeExecuteFor(EXTRACT_DOCUMENT_DATA_TOOL_NAME),
        }),
      );
    }

    if (skillDeclaresTool(skills, CALCULATE_UNIT_ECONOMICS_TOOL_NAME)) {
      tools.push(
        this.llmService.createCalculateUnitEconomicsTool({
          beforeExecute: beforeExecuteFor(CALCULATE_UNIT_ECONOMICS_TOOL_NAME),
        }),
      );
    }

    if (skillDeclaresTool(skills, DETECT_PROFIT_LEAKS_TOOL_NAME)) {
      tools.push(
        this.llmService.createDetectProfitLeaksTool({
          beforeExecute: beforeExecuteFor(DETECT_PROFIT_LEAKS_TOOL_NAME),
        }),
      );
    }

    if (skillDeclaresTool(skills, MONITOR_COMPETITOR_PRICES_TOOL_NAME)) {
      tools.push(
        this.llmService.createMonitorCompetitorPricesTool({
          beforeExecute: beforeExecuteFor(MONITOR_COMPETITOR_PRICES_TOOL_NAME),
        }),
      );
    }

    if (skillDeclaresTool(skills, AUDIT_FRAUD_RISK_TOOL_NAME)) {
      tools.push(
        this.llmService.createAuditFraudRiskTool({
          beforeExecute: beforeExecuteFor(AUDIT_FRAUD_RISK_TOOL_NAME),
        }),
      );
    }

    return tools;
  }
}
