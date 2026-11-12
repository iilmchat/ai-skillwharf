import {
  BadRequestException,
  ForbiddenException,
  Injectable,
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
import { BillingService } from '../billing/billing.service.js';
import { ERROR_KEYS } from '../i18n/error-keys.js';
import {
  EXEC_TOOL_NAME,
  LlmService,
  SANDBOX_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  messageContentToText,
  toLangChainMessage,
  type SandboxToolOptions,
} from '../llm/llm.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SkillsService } from '../skills/skills.service.js';
import {
  DEFAULT_OFFICE_AGENT_ID,
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

/**
 * Выполняет `tool_calls` текущего ответа модели. Ошибки инструмента
 * (например, от paywall) пробрасываются наружу и прерывают граф.
 */
async function executeToolCalls(
  tools: StructuredToolInterface[],
  calls: ToolCall[],
): Promise<ToolMessage[]> {
  return Promise.all(
    calls.map(async (call) => {
      const tool = tools.find((candidate) => candidate.name === call.name);

      if (!tool) {
        return new ToolMessage({
          tool_call_id: call.id ?? '',
          name: call.name,
          content: `Инструмент «${call.name}» не найден`,
          status: 'error',
        });
      }

      const result = await tool.invoke(call.args);

      return new ToolMessage({
        tool_call_id: call.id ?? '',
        name: call.name,
        content: typeof result === 'string' ? result : JSON.stringify(result),
      });
    }),
  );
}

/**
 * Граф состояний LangGraph в стиле AgentExecutor:
 *
 * `llm` → (есть tool_calls?) → `tools` → `llm` → … → END.
 *
 * Инструменты приходят в состоянии, потому что содержат привязанный к
 * пользователю paywall-хук.
 */
function buildChatGraph(llmService: LlmService) {
  return new StateGraph(ChatStateAnnotation)
    .addNode('llm', async (state: ChatState, config) => {
      const emit = getWriter(config);
      let text = '';
      let response: AIMessage | undefined;

      for await (const chunk of llmService.chatWithToolsStream(
        state.messages,
        state.availableTools,
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

      return {
        messages: [
          ...state.messages,
          ...(await executeToolCalls(state.availableTools, calls)),
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
  private readonly graph: ReturnType<typeof buildChatGraph>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly llmService: LlmService,
    private readonly billingService: BillingService,
    private readonly skillsService: SkillsService,
  ) {
    this.graph = buildChatGraph(this.llmService);
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
    const { messages, tools } = await this.prepareMessage(
      userId,
      conversationId,
      content,
    );

    let reply: string;

    try {
      const state = await this.graph.invoke({
        conversationId,
        messages,
        availableTools: tools,
      });
      reply = state.reply;
    } catch (error) {
      // Paywall: списание не удалось — песочница не запускалась,
      // прерываем граф и отдаём клиенту ключ ошибки для перевода.
      if (!(error instanceof BadRequestException)) {
        throw error;
      }

      reply = ERROR_KEYS.insufficientFunds;
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
    const { messages, tools } = await this.prepareMessage(
      userId,
      conversationId,
      content,
    );

    let reply = '';

    try {
      const stream = await this.graph.stream(
        { conversationId, messages, availableTools: tools },
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

    const tools = await this.buildTools(userId);

    return { messages, tools };
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

  /**
   * Инструменты, доступные агенту. Цена каждого берётся из манифеста
   * включённого навыка, объявившего инструмент; если цены нет — бесплатно.
   */
  private async buildTools(userId: string): Promise<StructuredToolInterface[]> {
    const skills = await this.skillsService.getEnabledSkills();

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

    return [
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
  }
}
