import {
  BadRequestException,
  ForbiddenException,
  Inject,
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
  Command,
  END,
  getWriter,
  interrupt,
  isInterrupted,
  Overwrite,
  START,
  StateGraph,
} from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { InstalledSkill } from '@prisma/client';
import { SkillManifestSchema } from '@skillwharf/shared';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
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
import { MemoryService } from '../memory/memory.service.js';
import { recordAgentRunSpan } from '../observability/tracing.js';
import type { EgressPolicy } from '../sandbox/egress.js';
import { AgentGatewayService } from '../security/agent-gateway.service.js';
import {
  extractSecretCandidates,
} from '../security/policy/secret-taint.js';
import type {
  PolicyDecision,
  ToolCallContext,
  ToolSkillContext,
  UserRole,
} from '../security/policy/policy.types.js';
import { SkillsService } from '../skills/skills.service.js';
import {
  LlmRouterService,
  type LlmRouteSelection,
} from '../llm-router/llm-router.service.js';
import {
  GRAPH_CHECKPOINTER,
} from './persistence/persistence.module.js';
import {
  PendingApprovalService,
  type PendingApprovalHold,
  type PendingApprovalReason,
} from './persistence/pending-approval.service.js';
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

/**
 * Сериализуемый снимок навыка, который хранится в checkpoint'е: после
 * рестарта API инструменты пересобираются из него, а не из памяти процесса.
 */
export type SkillSnapshot = Pick<
  InstalledSkill,
  'id' | 'name' | 'manifest' | 'isEnabled'
>;

/** Причина паузы графа: обычное подтверждение или Pay-per-Outcome. */
export type ChatApprovalReason = PendingApprovalReason;

/** Payload, который граф кладёт в interrupt() и отдаёт клиенту. */
export interface ChatApprovalInterrupt {
  type: 'approval';
  conversationId: string;
  userId: string;
  reason: ChatApprovalReason;
  tools: string[];
  task: string;
}

/** Ответ пользователя, которым возобновляется граф после interrupt. */
export interface ChatApprovalResume {
  approved: boolean;
}

/** Zod-схема resume-значения: внешний ввод от клиента. */
export const chatApprovalResumeSchema = z
  .object({ approved: z.boolean() })
  .strict();

/** Zod-схема payload'а interrupt: читаем из checkpoint после рестарта. */
export const chatApprovalInterruptSchema = z
  .object({
    type: z.literal('approval'),
    conversationId: z.string().min(1),
    userId: z.string().min(1),
    reason: z.enum(['approval', 'payment']),
    tools: z.array(z.string()),
    task: z.string(),
  })
  .strict();

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
  /**
   * Сериализуемый снимок навыков. Сами инструменты (StructuredToolInterface
   * с функциями) в состояние не кладём: они не сериализуются в PostgreSQL и
   * пересобираются из снимка при каждом запуске/возобновлении графа.
   */
  skills: Annotation<SkillSnapshot[]>({
    reducer: (_previous, next) => next,
    default: () => [],
  }),
  /** Инструменты, которые нельзя запускать без подтверждения пользователя. */
  approvalRequiredTools: Annotation<string[]>({
    reducer: (_previous, next) => next,
    default: () => [],
  }),
  /** Маршрут LLM, выбранный роутером перед запуском графа. */
  llmRoutes: Annotation<LlmRouteSelection[]>({
    reducer: (_previous, next) => next,
    default: () => [],
  }),
  /** Блок «Долговременная память», подобранный под последний вопрос. */
  memoryContext: Annotation<string>({
    reducer: (_previous, next) => next,
    default: () => '',
  }),
  /** Цены Pay-per-Outcome по именам инструментов. */
  outcomePrices: Annotation<Record<string, OutcomePrice>>({
    reducer: (_previous, next) => next,
    default: () => ({}),
  }),
  /** Роль пользователя для runtime-политик Agent Gateway. */
  userRole: Annotation<UserRole>({
    reducer: (_previous, next) => next,
    default: () => 'user',
  }),
  /** Навыки, объявившие инструменты (контекст политик). */
  toolSkills: Annotation<Record<string, ToolSkillContext[]>>({
    reducer: (_previous, next) => next,
    default: () => ({}),
  }),
  /**
   * Секрето-подобные значения из недоверенных источников (web_search,
   * внешние MCP). Живут в состоянии графа и передаются в policy engine на
   * следующих раундах: утечка в exec/песочницу блокируется, в поисковый
   * запрос — маскируется.
   */
  taintedSecrets: Annotation<string[]>({
    reducer: (previous, next) => [...new Set([...previous, ...next])],
    default: () => [],
  }),
});

type ChatState = typeof ChatStateAnnotation.State;

/**
 * Сбрасывает taint-канал перед новым сообщением пользователя: reducer
 * канала объединяет значения внутри одного прогона графа, а между
 * сообщениями старые секреты не должны блокировать новые вызовы.
 */
function overwriteEmptySecrets(): string[] {
  return new Overwrite([]) as unknown as string[];
}

export interface ChatReply {
  conversationId: string;
  reply: string;
  /**
   * `true`, если граф поставлен на паузу и ждёт `approve_action`.
   * Повторная отправка сообщения в такой диалог сначала завершает ожидание.
   */
  pendingApproval?: boolean;
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
  skills: readonly SkillSnapshot[],
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
function resolveApprovalTools(skills: readonly SkillSnapshot[]): string[] {
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
  skills: readonly SkillSnapshot[],
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

/** Инструменты, результат которых считается taint-источником. */
const TAINT_SOURCE_TOOLS = new Set([
  WEB_SEARCH_TOOL_NAME,
  OZON_MCP_TOOL_NAME,
  WB_MCP_TOOL_NAME,
]);

/** Роли, которые понимает policy engine; неизвестная роль — «user». */
const KNOWN_ROLES = new Set<UserRole>(['guest', 'user', 'admin', 'owner']);

/** Нормализует роль из JWT/БД к роли policy engine. */
export function normalizeUserRole(role: string | undefined): UserRole {
  if (role === undefined || role === '') {
    return 'user';
  }

  return KNOWN_ROLES.has(role as UserRole) ? (role as UserRole) : 'user';
}

/**
 * Контекст навыков по инструментам: какие включённые навыки объявили
 * инструмент, какие у них разрешения и egress-allowlist. Нужен policy engine
 * для проверки роли, сетевого доступа и taint-политик.
 */
export function buildToolSkillContexts(
  skills: readonly SkillSnapshot[],
): Record<string, ToolSkillContext[]> {
  const contexts: Record<string, ToolSkillContext[]> = {};

  for (const skill of skills) {
    const parsed = SkillManifestSchema.safeParse(skill.manifest);

    if (!parsed.success) {
      continue;
    }

    const manifest = parsed.data;
    const context: ToolSkillContext = {
      name: manifest.name,
      permissions: manifest.permissions,
      egressAllowlist: manifest.egress_allowlist ?? [],
    };

    for (const tool of manifest.dependencies?.tools ?? []) {
      (contexts[tool] ??= []).push(context);
    }
  }

  return contexts;
}

/**
 * Egress-политика для инструмента: объединение `egress_allowlist` навыков,
 * которые объявили инструмент и имеют разрешение `network`. Пустой список
 * означает запрет сети (deny by default, ADR 0004 п.3).
 */
export function resolveToolEgress(
  skills: readonly SkillSnapshot[],
  toolName: string,
): EgressPolicy | undefined {
  const allowlist = new Set<string>();

  for (const skill of skills) {
    const parsed = SkillManifestSchema.safeParse(skill.manifest);

    if (!parsed.success) {
      continue;
    }

    const manifest = parsed.data;

    if (
      !manifest.dependencies?.tools?.includes(toolName) ||
      !manifest.permissions.includes('network')
    ) {
      continue;
    }

    for (const domain of manifest.egress_allowlist ?? []) {
      allowlist.add(domain);
    }
  }

  return allowlist.size === 0 ? undefined : { allowlist: [...allowlist] };
}

/**
 * `mcp_endpoint` навыка, объявившего MCP-инструмент. Адрес MCP-сервера не
 * хардкодится в коде: источник истины — манифест включённого навыка.
 */
export function resolveToolMcpEndpoint(
  skills: readonly SkillSnapshot[],
  toolName: string,
): string | undefined {
  for (const skill of skills) {
    const parsed = SkillManifestSchema.safeParse(skill.manifest);

    if (!parsed.success) {
      continue;
    }

    const manifest = parsed.data;

    if (
      manifest.dependencies?.tools?.includes(toolName) &&
      manifest.mcp_endpoint !== undefined
    ) {
      return manifest.mcp_endpoint;
    }
  }

  return undefined;
}


/** Цены Pay-per-Outcome по инструментам из манифестов навыков. */
function resolveOutcomePrices(
  skills: readonly SkillSnapshot[],
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
  userRole: UserRole;
  toolSkills: Record<string, ToolSkillContext[]>;
  taintedSecrets: readonly string[];
  outcomePrices: Record<string, OutcomePrice>;
  preAuthorizedHolds: Map<number, EscrowHold>;
  billingService: BillingService;
  agentGateway: AgentGatewayService;
}

/** Результат выполнения пачки tool_calls: сообщения и новые taint-значения. */
interface ToolExecutionResult {
  messages: ToolMessage[];
  taintedSecrets: string[];
}

/**
 * Проверяет вызов политикой Agent Gateway и возвращает решение. Контекст
 * передаётся явно: роль пользователя, навыки, объявившие инструмент, и
 * значения, загрязнённые недоверенными источниками.
 */
function evaluateToolCall(
  call: ToolCall,
  options: Pick<
    ToolExecutionOptions,
    'userId' | 'userRole' | 'toolSkills' | 'taintedSecrets'
  >,
  agentGateway: AgentGatewayService,
): PolicyDecision {
  const context: ToolCallContext = {
    userId: options.userId,
    role: options.userRole,
    skills: options.toolSkills[call.name] ?? [],
    taintedSecrets: options.taintedSecrets,
  };

  return agentGateway.validateToolCall(call.name, call.args, context);
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
): Promise<ToolExecutionResult> {
  const taintedSecrets = new Set<string>();

  const messages = await Promise.all(
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

      // Policy engine валидирует аргументы по имени инструмента и может
      // замаскировать tainted-значения (например, в поисковом запросе).
      const decision = evaluateToolCall(call, options, options.agentGateway);
      const args = decision.args;
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

      const content =
        typeof result === 'string' ? result : JSON.stringify(result);

      // Результат недоверенного источника помечаем taint'ом: секрето-подобные
      // значения нельзя передавать в exec/песочницу/MCP на следующих шагах.
      if (TAINT_SOURCE_TOOLS.has(call.name)) {
        for (const secret of extractSecretCandidates(content)) {
          taintedSecrets.add(secret);
        }
      }

      return new ToolMessage({
        tool_call_id: call.id ?? '',
        name: call.name,
        content,
      });
    }),
  );

  return { messages, taintedSecrets: [...taintedSecrets] };
}

/**
 * Граф состояний LangGraph в стиле AgentExecutor:
 *
 * `llm` → (есть tool_calls?) → `tools` → `llm` → … → END.
 *
 * Инструменты не хранятся в состоянии (они не сериализуются): вместо них в
 * checkpoint пишется снимок навыков, а `resolveTools` пересобирает инструменты
 * с привязанным к пользователю paywall-хуком при каждом запуске, в том числе
 * после рестарта API.
 */
function buildChatGraph(
  llmService: LlmService,
  billingService: BillingService,
  agentGateway: AgentGatewayService,
  pendingApprovals: PendingApprovalService,
  checkpointer: BaseCheckpointSaver,
  resolveTools: (state: ChatState) => StructuredToolInterface[],
) {
  return new StateGraph(ChatStateAnnotation)
    .addNode('llm', async (state: ChatState, config) => {
      const emit = getWriter(config);
      let text = '';
      let response: AIMessage | undefined;

      for await (const chunk of llmService.chatWithToolsStream(
        state.messages,
        resolveTools(state),
        state.llmRoutes,
        {
          userId: state.userId,
          memoryContext: state.memoryContext,
          agentId: DEFAULT_OFFICE_AGENT_ID,
          skillId: state.skills.map((skill) => skill.id).join(',') || undefined,
        },
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
      const tools = resolveTools(state);
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
          evaluateToolCall(call, state, agentGateway);
        }

        // Holds создаются ДО interrupt() и с детерминированным idempotencyKey:
        // узел повторно выполняется при возобновлении (в том числе после
        // рестарта API), и authorizeHold должен вернуть существующий
        // PENDING-entry, а не создать второй.
        const holds: PendingApprovalHold[] = [];

        try {
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
              `approval:${state.conversationId}:${call.id ?? String(index)}`,
            );

            preAuthorizedHolds.set(index, { entryId: authorized.entryId });
            holds.push({
              callId: call.id ?? String(index),
              toolName: call.name,
              entryId: authorized.entryId,
            });
          }
        } catch (error) {
          await Promise.all(
            [...preAuthorizedHolds.values()].map((hold) =>
              billingService.cancelHold(hold.entryId),
            ),
          );
          throw error;
        }

        const reason: ChatApprovalReason = approvalCalls.some((call) =>
          Boolean(state.outcomePrices[call.name]),
        )
          ? 'payment'
          : 'approval';
        const approvalTools = approvalCalls.map((call) => call.name);

        // Запись в БД переживает рестарт API и используется эндпоинтом
        // списка ожидающих; сама пауза графа хранится в checkpoint'е.
        await pendingApprovals.upsertPending({
          conversationId: state.conversationId,
          userId: state.userId,
          reason,
          tools: approvalTools,
          holds,
        });

        const interruptPayload: ChatApprovalInterrupt = {
          type: 'approval',
          conversationId: state.conversationId,
          userId: state.userId,
          reason,
          tools: approvalTools,
          task: `${OFFICE_TASKS.waitingApproval}: ${officeTaskForTool(
            approvalTools[0] ?? '',
          )}`,
        };

        // Останавливает граф; resume-значение проверяется Zod-схемой.
        const resume = interrupt<ChatApprovalInterrupt, ChatApprovalResume>(
          interruptPayload,
          { responseSchema: chatApprovalResumeSchema },
        );

        if (!resume.approved) {
          await pendingApprovals.resolvePending(
            state.conversationId,
            'rejected',
          );
          await Promise.all(
            holds.map((hold) => billingService.cancelHold(hold.entryId)),
          );

          return {
            messages: [
              ...state.messages,
              ...calls.map(
                (call) =>
                  new ToolMessage({
                    tool_call_id: call.id ?? '',
                    name: call.name,
                    content: 'Действие отклонено пользователем',
                    status: 'error',
                  }),
              ),
            ],
          };
        }

        await pendingApprovals.resolvePending(state.conversationId, 'approved');
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

      const execution = await executeToolCalls(tools, calls, {
        userId: state.userId,
        userRole: state.userRole,
        toolSkills: state.toolSkills,
        taintedSecrets: state.taintedSecrets,
        outcomePrices: state.outcomePrices,
        preAuthorizedHolds,
        billingService,
        agentGateway,
      });

      return {
        messages: [...state.messages, ...execution.messages],
        taintedSecrets: execution.taintedSecrets,
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
    .compile({ checkpointer });
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private readonly graph: ReturnType<typeof buildChatGraph>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly llmService: LlmService,
    private readonly billingService: BillingService,
    private readonly skillsService: SkillsService,
    private readonly llmRouterService: LlmRouterService,
    private readonly agentGateway: AgentGatewayService,
    private readonly memoryService: MemoryService,
    @Inject(GRAPH_CHECKPOINTER)
    private readonly checkpointer: BaseCheckpointSaver,
    private readonly pendingApprovalService: PendingApprovalService,
  ) {
    this.graph = buildChatGraph(
      this.llmService,
      this.billingService,
      this.agentGateway,
      this.pendingApprovalService,
      this.checkpointer,
      (state) => this.buildTools(state.userId, state.skills),
    );
  }

  /** Конфигурация checkpoint-треда: один диалог — один thread. */
  private graphConfig(conversationId: string): {
    configurable: { thread_id: string };
  } {
    return { configurable: { thread_id: conversationId } };
  }

  /**
   * Возобновляет граф, приостановленный перед инструментом, которому нужно
   * одобрение. Работает после рестарта API: состояние графа читается из
   * PostgreSQL-checkpoint'а, holds — из append-only Ledger.
   *
   * Возвращает `null`, если ожидания нет или оно принадлежит другому
   * пользователю (проверка прав — до возобновления).
   */
  async approveAction(
    userId: string,
    conversationId: string,
    approved: boolean,
    onDelta?: (text: string) => void,
    onOfficeEvent?: (event: OfficeEvent) => void,
  ): Promise<ChatReply | null> {
    await this.assertConversationOwner(userId, conversationId);

    const pending =
      await this.pendingApprovalService.findPending(conversationId);

    if (pending === null || pending.userId !== userId) {
      return null;
    }

    const config = this.graphConfig(conversationId);
    const snapshot = await this.graph.getState(config);

    if (snapshot.next.length === 0) {
      // Граф уже завершён, а запись осталась pending (например, гонка двух
      // approve_action): закрываем её без возобновления.
      await this.pendingApprovalService.resolvePending(
        conversationId,
        approved ? 'approved' : 'rejected',
      );

      return null;
    }

    onOfficeEvent?.({
      conversationId,
      agentId: DEFAULT_OFFICE_AGENT_ID,
      status: 'working',
      task: OFFICE_TASKS.resumingAfterApproval,
    });

    const stream = await this.graph.stream(
      new Command({ resume: { approved } satisfies ChatApprovalResume }),
      { ...config, streamMode: ['custom', 'values'] },
    );
    const reply = await this.consumeGraphStream(
      stream,
      conversationId,
      onDelta,
      onOfficeEvent,
    );

    const interrupt = await this.findPendingInterrupt(conversationId);

    if (interrupt !== null) {
      this.emitWaitingApproval(interrupt, onOfficeEvent);

      return { conversationId, reply, pendingApproval: true };
    }

    await this.persistReply(conversationId, reply);
    await this.rememberReply(userId, reply);

    return { conversationId, reply };
  }

  /** Список диалогов пользователя, ожидающих `approve_action`. */
  async listPendingApprovals(userId: string): Promise<
    Array<{
      conversationId: string;
      reason: ChatApprovalReason;
      tools: string[];
      createdAt: string;
      /** Дедлайн решения (ISO) для таймера в UI; нет поля — ожидание без TTL. */
      expiresAt?: string;
    }>
  > {
    const pending = await this.pendingApprovalService.listPending(userId);

    return pending.map((item) => ({
      conversationId: item.conversationId,
      reason: item.reason,
      tools: item.tools,
      createdAt: item.createdAt.toISOString(),
      // Просроченные не отдаются сервисом; старое ожидание без TTL просто
      // не содержит поле, чтобы клиент не показывал таймер.
      ...(item.expiresAt == null
        ? {}
        : { expiresAt: item.expiresAt.toISOString() }),
    }));
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

  /** Удаляет всю долговременную память пользователя (GDPR/152-ФЗ). */
  async clearMemory(userId: string): Promise<{ deleted: number }> {
    const deleted = await this.memoryService.clear(userId);

    return { deleted };
  }

  async handleMessage(
    userId: string,
    conversationId: string,
    content: string,
  ): Promise<ChatReply> {
    const prepared = await this.prepareMessage(
      userId,
      conversationId,
      content,
    );
    this.logAgentContext(
      userId,
      conversationId,
      prepared.skills.map((skill) => skill.id),
    );
    const llmRoutes = await this.llmRouterService.selectRoutes('chat');

    let reply: string;

    try {
      const state = await this.graph.invoke(
        {
          conversationId,
          userId,
          messages: prepared.messages,
          skills: prepared.skills,
          approvalRequiredTools: prepared.approvalRequiredTools,
          outcomePrices: prepared.outcomePrices,
          llmRoutes,
          memoryContext: prepared.memoryContext,
          userRole: prepared.userRole,
          toolSkills: prepared.toolSkills,
          taintedSecrets: overwriteEmptySecrets(),
        },
        this.graphConfig(conversationId),
      );

      if (isInterrupted(state)) {
        return { conversationId, reply: '', pendingApproval: true };
      }

      reply = (state as ChatState).reply;
    } catch (error) {
      // Paywall: списание не удалось — песочница не запускалась,
      // прерываем граф и отдаём клиенту ключ ошибки для перевода.
      if (!(error instanceof BadRequestException)) {
        throw error;
      }

      reply = ERROR_KEYS.insufficientFunds;
    }

    await this.persistReply(conversationId, reply);
    await this.rememberExchange(userId, content, reply);

    return { conversationId, reply };
  }

  /**
   * Стриминговый ответ: граф запускается в режиме `custom`, а каждый
   * сгенерированный фрагмент текста уходит в `onDelta`. Если граф встал на
   * паузу (`interrupt`), клиент получает `waiting_approval`, а ответ будет
   * сгенерирован после `approve_action` — в том числе после рестарта API.
   */
  async streamMessage(
    userId: string,
    conversationId: string,
    content: string,
    onDelta: (text: string) => void,
    onOfficeEvent?: (event: OfficeEvent) => void,
  ): Promise<ChatReply> {
    const prepared = await this.prepareMessage(
      userId,
      conversationId,
      content,
    );
    this.logAgentContext(
      userId,
      conversationId,
      prepared.skills.map((skill) => skill.id),
    );
    const llmRoutes = await this.llmRouterService.selectRoutes('chat');

    let reply = '';

    try {
      const stream = await this.graph.stream(
        {
          conversationId,
          userId,
          messages: prepared.messages,
          skills: prepared.skills,
          approvalRequiredTools: prepared.approvalRequiredTools,
          outcomePrices: prepared.outcomePrices,
          llmRoutes,
          memoryContext: prepared.memoryContext,
          userRole: prepared.userRole,
          toolSkills: prepared.toolSkills,
          taintedSecrets: overwriteEmptySecrets(),
        },
        { ...this.graphConfig(conversationId), streamMode: ['custom', 'values'] },
      );

      reply = await this.consumeGraphStream(
        stream,
        conversationId,
        onDelta,
        onOfficeEvent,
      );
    } catch (error) {
      if (!(error instanceof BadRequestException)) {
        throw error;
      }

      reply = ERROR_KEYS.insufficientFunds;
      onDelta(reply);
    }

    const interrupt = await this.findPendingInterrupt(conversationId);

    if (interrupt !== null) {
      this.emitWaitingApproval(interrupt, onOfficeEvent);

      return { conversationId, reply, pendingApproval: true };
    }

    await this.persistReply(conversationId, reply);
    await this.rememberExchange(userId, content, reply);

    return { conversationId, reply };
  }

  /**
   * Читает custom/values-стрим графа. Возвращает накопленный reply из
   * values-чанков и прокидывает дельты/office-события наружу.
   */
  private async consumeGraphStream(
    stream: AsyncIterable<unknown>,
    conversationId: string,
    onDelta?: (text: string) => void,
    onOfficeEvent?: (event: OfficeEvent) => void,
  ): Promise<string> {
    let reply = '';

    for await (const event of stream) {
      const [mode, chunk] = event as [string, unknown];

      if (mode === 'custom') {
        const custom = chunk as Partial<ChatStreamEvent>;

        if (custom.type === 'delta' && typeof custom.text === 'string') {
          onDelta?.(custom.text);
        } else if (custom.type === 'office') {
          const officeEvent = custom as ChatOfficeEvent;

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
        // На чанке с `__interrupt__` поля reply может не быть — не затираем
        // уже накопленное значение.
        const values = chunk as Partial<ChatState>;

        if (typeof values.reply === 'string') {
          reply = values.reply;
        }
      }
    }

    return reply;
  }

  /**
   * Возвращает payload ожидающего `interrupt` из checkpoint'а. Именно этот
   * запрос переживает рестарт API — оперативной карты ожиданий больше нет.
   */
  private async findPendingInterrupt(
    conversationId: string,
  ): Promise<ChatApprovalInterrupt | null> {
    const snapshot = await this.graph.getState(
      this.graphConfig(conversationId),
    );

    if (snapshot.next.length === 0) {
      return null;
    }

    for (const task of snapshot.tasks) {
      for (const interrupt of task.interrupts ?? []) {
        const parsed = chatApprovalInterruptSchema.safeParse(interrupt.value);

        if (parsed.success) {
          return parsed.data;
        }
      }
    }

    return null;
  }

  /** Отправляет клиенту событие ожидания подтверждения. */
  private emitWaitingApproval(
    interrupt: ChatApprovalInterrupt,
    onOfficeEvent?: (event: OfficeEvent) => void,
  ): void {
    onOfficeEvent?.({
      conversationId: interrupt.conversationId,
      agentId: DEFAULT_OFFICE_AGENT_ID,
      status: 'waiting_approval',
      task: interrupt.task,
      reason: interrupt.reason,
    });
  }

  /** Проверяет существование диалога и его принадлежность пользователю. */
  private async assertConversationOwner(
    userId: string,
    conversationId: string,
  ): Promise<void> {
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
  }

  /**
   * Отменяет «зависшее» одобрение при новом сообщении в том же диалоге:
   * escrow-holds возвращаются пользователю, запись ожидания закрывается,
   * checkpoint треда удаляется (следующий запуск графа стартует с начала).
   */
  private async discardStaleApproval(conversationId: string): Promise<void> {
    const pending =
      await this.pendingApprovalService.findPending(conversationId);

    if (pending === null) {
      return;
    }

    await this.pendingApprovalService.resolvePending(
      conversationId,
      'rejected',
    );
    await Promise.all(
      pending.holds.map((hold) =>
        this.billingService.cancelHold(hold.entryId),
      ),
    );
    await this.checkpointer.deleteThread(conversationId);

    this.logger.log(
      `Отменено устаревшее ожидание одобрения: conversationId=${conversationId}`,
    );
  }

  /** Проверяет диалог, баланс, сохраняет вопрос и собирает контекст. */
  private async prepareMessage(
    userId: string,
    conversationId: string,
    content: string,
  ): Promise<{
    messages: BaseMessage[];
    skills: SkillSnapshot[];
    approvalRequiredTools: string[];
    outcomePrices: Record<string, OutcomePrice>;
    memoryContext: string;
    userRole: UserRole;
    toolSkills: Record<string, ToolSkillContext[]>;
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

    // Новое сообщение в диалоге, где висит старое неподтверждённое действие,
    // означает отказ от него: отменяем escrow-holds и чистим checkpoint,
    // чтобы граф стартовал с чистого состояния.
    await this.discardStaleApproval(conversationId);

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

    const skills = (await this.skillsService.getEnabledSkills()).map(
      (skill): SkillSnapshot => ({
        id: skill.id,
        name: skill.name,
        manifest: skill.manifest,
        isEnabled: skill.isEnabled,
      }),
    );

    const approvalRequiredTools = resolveApprovalTools(skills);
    const outcomePrices = resolveOutcomePrices(skills);
    const toolSkills = buildToolSkillContexts(skills);
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    const userRole = normalizeUserRole(user?.role);

    // Долговременная память: top-K фрагментов под последний вопрос.
    // Ошибки внутри MemoryService не прерывают диалог.
    const memoryContext = await this.memoryService.buildContext(
      userId,
      content,
    );

    return {
      messages,
      skills,
      approvalRequiredTools,
      outcomePrices,
      memoryContext,
      userRole,
      toolSkills,
    };
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

  /**
   * Дополняет память ответом, сгенерированным после `approve_action`.
   * Пользовательское сообщение уже было записано при постановке на паузу.
   */
  private async rememberReply(userId: string, reply: string): Promise<void> {
    if (reply.trim() === '') {
      return;
    }

    try {
      await this.memoryService.remember(userId, reply);
    } catch (error) {
      this.logger.warn(
        `Не удалось обновить долговременную память: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Сохраняет новые сообщения диалога в долговременную память. Сбой памяти
   * логируется, но не ломает уже сгенерированный ответ.
   */
  private async rememberExchange(
    userId: string,
    userContent: string,
    reply: string,
  ): Promise<void> {
    try {
      await this.memoryService.remember(userId, userContent);

      if (reply.trim() !== '') {
        await this.memoryService.remember(userId, reply);
      }
    } catch (error) {
      this.logger.warn(
        `Не удалось обновить долговременную память: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Проверяет минимальный баланс перед запуском графа. */
  private async assertSufficientBalance(userId: string): Promise<void> {
    const { balance } = await this.billingService.getBalance(userId);

    if (Number.parseFloat(balance) < MIN_AGENT_BALANCE) {
      throw new BadRequestException(ERROR_KEYS.insufficientFunds);
    }
  }

  /**
   * OTel-атрибуты запуска агента: агент и tenant (владелец диалога).
   * Пишем JSON в лог приложения, чтобы позже подключить OTLP-экспорт.
   */
  private logAgentContext(
    userId: string,
    conversationId: string,
    skillIds: readonly string[] = [],
  ): void {
    this.logger.log(
      JSON.stringify({
        event: 'gen_ai.agent.run',
        'gen_ai.agent.id': DEFAULT_OFFICE_AGENT_ID,
        'gen_ai.tenant.id': userId,
        'gen_ai.skill.id':
          skillIds.length > 0 ? skillIds.join(',') : 'unknown',
        conversationId,
      }),
    );

    recordAgentRunSpan({
      agentId: DEFAULT_OFFICE_AGENT_ID,
      tenantId: userId,
      skillIds,
    });
  }

  /**
   * Инструменты, доступные агенту. Цена каждого берётся из манифеста
   * включённого навыка, объявившего инструмент; если цены нет — бесплатно.
   */
  private buildTools(
    userId: string,
    skills: readonly SkillSnapshot[],
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
        egress: resolveToolEgress(skills, SANDBOX_TOOL_NAME),
      }),
      this.llmService.createWebSearchTool({
        beforeExecute: beforeExecuteFor(WEB_SEARCH_TOOL_NAME),
        egress: resolveToolEgress(skills, WEB_SEARCH_TOOL_NAME),
      }),
      this.llmService.createExecTool({
        beforeExecute: beforeExecuteFor(EXEC_TOOL_NAME),
        egress: resolveToolEgress(skills, EXEC_TOOL_NAME),
      }),
    ];

    // Marketplace-инструменты подключаются только если их объявил
    // установленный и включённый навык (ozon-seller / wb-seller).
    // Advisor MCP-сервера берётся из поля `mcp_endpoint` манифеста.
    if (skillDeclaresTool(skills, OZON_MCP_TOOL_NAME)) {
      tools.push(
        this.llmService.createOzonMcpTool({
          beforeExecute: beforeExecuteFor(OZON_MCP_TOOL_NAME),
          endpoint: resolveToolMcpEndpoint(skills, OZON_MCP_TOOL_NAME),
        }),
      );
    }

    if (skillDeclaresTool(skills, WB_MCP_TOOL_NAME)) {
      tools.push(
        this.llmService.createWbMcpTool({
          beforeExecute: beforeExecuteFor(WB_MCP_TOOL_NAME),
          endpoint: resolveToolMcpEndpoint(skills, WB_MCP_TOOL_NAME),
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
