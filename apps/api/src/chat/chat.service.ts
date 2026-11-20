import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma, type InstalledSkill } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { SkillManifestSchema } from '@skillwharf/shared';
import { BillingService } from '../billing/billing.service.js';
import { ERROR_KEYS } from '../i18n/error-keys.js';
import { MemoryService } from '../memory/memory.service.js';
import { PromptsService } from '../prompts/prompts.service.js';
import type { UserRole } from '../security/policy/policy.types.js';
import {
  approvalRuleFor,
  getToolPolicy,
} from '../security/policy/tool-policies.js';
import { SkillsService } from '../skills/skills.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  LlmRouterService,
  type LlmRouteSelection,
} from '../llm-router/llm-router.service.js';
import {
  ModelCascadeService,
  type ModelTier,
} from '../llm-router/model-cascade.service.js';
import {
  PiiMaskingService,
  type PiiMaskResult,
} from '../security/pii-masking.service.js';
import {
  ApiException,
  insufficientFundsError,
} from '../common/api-error.js';
import {
  assistantMetadataSchema,
  parseArtifacts,
  type AssistantMetadata,
} from './artifact-parser.js';
import { CheckpointStoreService } from '../agent/checkpoint-store.service.js';
import {
  PendingApprovalService,
  type PendingApprovalReason,
} from './persistence/pending-approval.service.js';
import {
  DEFAULT_OFFICE_AGENT_ID,
  OFFICE_TASKS,
  type OfficeEvent,
} from './office-events.js';
import { AgentToolsService } from '../agent/agent-tools.service.js';
import type {
  AgentRole,
  ApprovalRule,
  ArtifactItem,
  Citation,
  ExecutionStep,
  GraphEvent,
  OutcomePrice,
  ResumeGraphRequest,
  RunGraphRequest,
} from '../agent/contracts.js';
import { LlmWorkerClient } from '../agent/llm-worker.client.js';
import { SemanticCacheService } from '../llm/semantic-cache.service.js';
import { WorkspacesService } from '../workspaces/workspaces.service.js';
import {
  customAgentRoleContextSchema,
  type CustomAgentRoleContext,
} from '../workspaces/custom-agents.schemas.js';

/** Сколько последних сообщений уходит в LLM. */
export const CHAT_HISTORY_LIMIT = 10;

/** Минимальный баланс для запуска агента. */
export const MIN_AGENT_BALANCE = 0.5;

/** Заголовок блока долговременной памяти в системном промпте. */
export const MEMORY_PROMPT_HEADER = '## Долговременная память';

const DEFAULT_CONVERSATION_TITLE = 'Новый диалог';

/** Снимок навыка, который уходит в worker для OTel-атрибутов. */
export type SkillSnapshot = Pick<
  InstalledSkill,
  'id' | 'name' | 'manifest' | 'isEnabled'
>;

/** Причина паузы графа: обычное подтверждение или Pay-per-Outcome. */
export type ChatApprovalReason = PendingApprovalReason;

export interface ChatReply {
  conversationId: string;
  reply: string;
  pendingApproval?: boolean;
  /** Ответ взят из семантического кеша — LLM не вызывалась (CACHE-30.2). */
  cacheHit?: boolean;
  /** Структурированные артефакты ответа (UX-37.1). */
  artifacts?: ArtifactItem[];
  /** Хронология шагов графа (UX-37.3). */
  executionTrace?: ExecutionStep[];
  /** Сноски на фрагменты базы знаний (KB-38.2). */
  citations?: Citation[];
  /** Сколько ПДн заменено до отправки в LLM (PII-44.2). */
  piiMaskedCount?: number;
  /** Уровень модели каскада (CASCADE-44.1). */
  modelTier?: ModelTier;
}

interface HistoryMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface PreparedMessage {
  messages: HistoryMessage[];
  skills: SkillSnapshot[];
  approvalRequiredTools: string[];
  approvalRules: ApprovalRule[];
  outcomePrices: Record<string, OutcomePrice>;
  memoryContext: string;
  /** Сноски, соответствующие фрагментам памяти в systemPrompt. */
  citations: Citation[];
  userRole: UserRole;
  toolSkills: Record<string, WorkerToolSkillContext[]>;
  systemPrompt: string;
  /** Активные кастомные роли воркспейса (BUILDER-35.1/35.2/35.3). */
  customRoles: CustomAgentRoleContext[];
  tools: ReturnType<AgentToolsService['buildDescriptors']>;
}

interface StreamResult {
  reply: string;
  pendingApproval: boolean;
  artifacts: ArtifactItem[];
  executionTrace: ExecutionStep[];
}

/** Роли, выводимые из имён подключённых навыков (GRAPH-30.1). */
const ROLE_SKILL_HINTS: ReadonlyArray<readonly [AgentRole, readonly string[]]> = [
  ['researcher', ['research', 'search', 'tavily', 'поиск']],
  ['drafter', ['draft', 'article', 'docx', 'content', 'статья']],
  ['reviewer', ['review', 'audit', 'check', 'провер']],
  ['analyst', ['analy', 'finance', 'report', 'аналит']],
  ['operator', ['erp', 'order', 'demand', 'moysklad', 'bitrix']],
];

export function orchestrationFromSkills(
  skills: readonly SkillSnapshot[],
): { orchestrationMode: 'single' | 'supervisor'; agentRoles?: AgentRole[] } {
  const roles: AgentRole[] = [];
  const names = skills.map((skill) => skill.name.toLowerCase());

  for (const [role, hints] of ROLE_SKILL_HINTS) {
    if (names.some((name) => hints.some((hint) => name.includes(hint)))) {
      roles.push(role);
    }
  }

  return roles.length >= 2
    ? { orchestrationMode: 'supervisor', agentRoles: roles }
    : { orchestrationMode: 'single' };
}

type Orchestration = ReturnType<typeof orchestrationFromSkills>;

/** Добавляет roleKey кастомных ролей к списку ролей графа (не более 5). */
export function mergeCustomAgentRoles(
  base: Orchestration,
  custom: readonly CustomAgentRoleContext[],
): Orchestration {
  if (custom.length === 0) {
    return base;
  }

  const roles = [...(base.agentRoles ?? []), ...custom.map((role) => role.roleKey)];

  return {
    orchestrationMode: 'supervisor',
    agentRoles: [...new Set(roles)].slice(0, 5),
  };
}

/** Инструкции и навыки активных ролей — в системный промпт сессии. */
export function customRolesPrompt(
  custom: readonly CustomAgentRoleContext[],
): string {
  if (custom.length === 0) {
    return '';
  }

  const blocks = custom.map((role) =>
    [
      `### ${role.name} (${role.roleKey})`,
      role.systemPrompt,
      `Навыки: ${role.skillSlugs.length > 0 ? role.skillSlugs.join(', ') : 'нет'}`,
      `HITL: ${role.hitlPolicy}; дневной лимит: ${role.dailyBudgetRub === null ? 'без ограничения' : `${role.dailyBudgetRub} ₽`}`,
    ].join('\n'),
  );

  return `\n\n## Кастомные роли воркспейса\n${blocks.join('\n\n')}`;
}

/** Роли, которые понимает policy engine; неизвестная роль — «user». */
const KNOWN_ROLES = new Set<UserRole>(['guest', 'user', 'admin', 'owner']);

export function normalizeUserRole(role: string | undefined): UserRole {
  if (role === undefined || role === '') {
    return 'user';
  }

  return KNOWN_ROLES.has(role as UserRole) ? (role as UserRole) : 'user';
}

/** Инструменты, требующие подтверждения по манифестам навыков. */
export function resolveApprovalTools(skills: readonly SkillSnapshot[]): string[] {
  const tools = new Set<string>();

  for (const skill of skills) {
    const parsed = SkillManifestSchema.safeParse(skill.manifest);

    if (!parsed.success || parsed.data.requiresApproval !== true) {
      continue;
    }

    for (const tool of parsed.data.dependencies?.tools ?? []) {
      // Политика может сузить HITL навыка: читающие инструменты (например,
      // `bitrix24_get_deal`) помечены `approval: 'none'` и не должны
      // останавливать граф, даже если навык целиком требует подтверждения.
      if (getToolPolicy(tool)?.approval === 'none') {
        continue;
      }

      tools.add(tool);
    }
  }

  return [...tools];
}

/**
 * Условия HITL по аргументам для инструментов из манифестов (KI-079).
 *
 * Передаются worker'у вместе с `approvalRequiredTools`: инструмент без
 * правила подтверждается всегда, инструмент с правилом — только при
 * совпадении значения аргумента (например, `stageId: WON`).
 */
export function resolveApprovalRules(
  skills: readonly SkillSnapshot[],
): ApprovalRule[] {
  const rules = new Map<string, ApprovalRule>();

  for (const skill of skills) {
    const parsed = SkillManifestSchema.safeParse(skill.manifest);

    if (!parsed.success || parsed.data.requiresApproval !== true) {
      continue;
    }

    for (const tool of parsed.data.dependencies?.tools ?? []) {
      const rule = approvalRuleFor(tool);

      if (rule !== null) {
        rules.set(tool, rule);
      }
    }
  }

  return [...rules.values()];
}

/** Цены Pay-per-Outcome по инструментам из манифестов навыков. */
export function resolveOutcomePrices(
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

/** Контекст навыка для worker'а: массивы mutable, как в Zod-контракте. */
export interface WorkerToolSkillContext {
  name: string;
  permissions: Array<
    'network' | 'filesystem' | 'shell' | 'secrets' | 'hardware'
  >;
  egressAllowlist: string[];
}

/** Контекст навыков по инструментам для policy engine. */
export function buildToolSkillContexts(
  skills: readonly SkillSnapshot[],
): Record<string, WorkerToolSkillContext[]> {
  const contexts: Record<string, WorkerToolSkillContext[]> = {};

  for (const skill of skills) {
    const parsed = SkillManifestSchema.safeParse(skill.manifest);

    if (!parsed.success) {
      continue;
    }

    const manifest = parsed.data;
    const context: WorkerToolSkillContext = {
      name: manifest.name,
      permissions: [...manifest.permissions],
      egressAllowlist: [...(manifest.egress_allowlist ?? [])],
    };

    for (const tool of manifest.dependencies?.tools ?? []) {
      (contexts[tool] ??= []).push(context);
    }
  }

  return contexts;
}

/** Добавляет найденный контекст памяти в системный промпт. */
export function withMemoryContext(
  systemPrompt: string,
  memoryContext?: string,
): string {
  const memory = memoryContext?.trim() ?? '';

  if (memory === '') {
    return systemPrompt;
  }

  return `${systemPrompt}\n\n${MEMORY_PROMPT_HEADER}\n${memory}`;
}

/**
 * Оркестратор чата в API.
 *
 * Всё, что связано с LangGraph/LangChain, вынесено в `llm-worker`. Gateway
 * готовит состояние, инструменты и бюджетный контекст, а затем читает
 * NDJSON-события worker'а: дельты, события AI-Офиса и HITL-подтверждения.
 */
@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly worker: LlmWorkerClient,
    private readonly billingService: BillingService,
    private readonly skillsService: SkillsService,
    private readonly llmRouterService: LlmRouterService,
    private readonly memoryService: MemoryService,
    private readonly promptsService: PromptsService,
    private readonly checkpoints: CheckpointStoreService,
    private readonly pendingApprovalService: PendingApprovalService,
    private readonly toolsService: AgentToolsService,
    @Optional() private readonly semanticCache?: SemanticCacheService,
    @Optional() private readonly workspaces?: WorkspacesService,
    @Optional() private readonly pii?: PiiMaskingService,
    @Optional() private readonly cascade?: ModelCascadeService,
  ) {}

  /**
   * Возобновляет граф после подтверждения. Checkpoint читается worker'ом из
   * API-хранилища, поэтому пауза переживает рестарт Gateway.
   */
  async approveAction(
    userId: string,
    conversationId: string,
    approved: boolean,
    onDelta?: (text: string) => void,
    onOfficeEvent?: (event: OfficeEvent) => void,
    workspaceId?: string,
  ): Promise<ChatReply | null> {
    await this.assertConversationOwner(userId, conversationId);

    const pending =
      await this.pendingApprovalService.findPending(conversationId);

    if (pending === null || pending.userId !== userId) {
      return null;
    }

    // ORG-31.2: viewer не может одобрять HITL; лимит роли проверяется по
    // сумме зарезервированных hold-проводок.
    if (approved && this.workspaces !== undefined) {
      await this.workspaces.assertRole(
        userId,
        this.workspaces.payingRoles(),
        workspaceId,
      );
      await this.workspaces.assertHitlLimit(
        userId,
        await this.pendingAmountRub(pending.holds.map((hold) => hold.entryId)),
        workspaceId,
      );
    }

    onOfficeEvent?.({
      conversationId,
      agentId: DEFAULT_OFFICE_AGENT_ID,
      status: 'working',
      task: OFFICE_TASKS.resumingAfterApproval,
    });

    const context = await this.buildGraphContext(userId, conversationId);
    const request: ResumeGraphRequest = {
      ...context,
      conversationId,
      userId,
      approved,
      llmRoutes: [],
      taintedSecrets: [],
    };
    const result = await this.consumeWorkerStream(
      this.worker.resume(request),
      conversationId,
      onDelta,
      onOfficeEvent,
    );

    if (result.pendingApproval) {
      return { conversationId, reply: result.reply, pendingApproval: true };
    }

    await this.persistReply(conversationId, result.reply);
    await this.rememberReply(userId, result.reply);

    return { conversationId, reply: result.reply };
  }

  /** Сумма зарезервированных hold-проводок в ₽ (для ABAC-лимита HITL). */
  private async pendingAmountRub(entryIds: readonly string[]): Promise<number> {
    if (entryIds.length === 0) {
      return 0;
    }

    try {
      const rows = await this.prisma.ledgerEntry.findMany({
        where: { id: { in: [...entryIds] } },
        select: { amount: true },
      });

      return rows.reduce((sum, row) => sum + row.amount.toNumber(), 0);
    } catch {
      return 0;
    }
  }

  /** Список диалогов пользователя, ожидающих `approve_action`. */
  async listPendingApprovals(userId: string): Promise<
    Array<{
      conversationId: string;
      reason: ChatApprovalReason;
      tools: string[];
      createdAt: string;
      expiresAt?: string;
    }>
  > {
    const pending = await this.pendingApprovalService.listPending(userId);

    return pending.map((item) => ({
      conversationId: item.conversationId,
      reason: item.reason,
      tools: item.tools,
      createdAt: item.createdAt.toISOString(),
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
    return { deleted: await this.memoryService.clear(userId) };
  }

  /** viewer не может запускать платные инструменты (ORG-31.2). */
  private async assertPaidToolsAllowed(
    userId: string,
    prepared: PreparedMessage,
  ): Promise<void> {
    if (this.workspaces === undefined) {
      return;
    }

    const paid = prepared.skills.some((skill) => {
      const parsed = SkillManifestSchema.safeParse(skill.manifest);

      return (
        parsed.success &&
        (parsed.data.pricing?.model === 'Pay-per-Call' ||
          parsed.data.pricing?.model === 'Pay-per-Outcome')
      );
    });

    if (paid) {
      await this.workspaces.assertRole(userId, this.workspaces.payingRoles());
    }
  }

  /** Ключ семантического кеша строго изолирован по userId/промпту/модели. */
  private cacheQuery(
    userId: string,
    content: string,
    prepared: PreparedMessage,
    routes: LlmRouteSelection[],
  ) {
    if (this.semanticCache === undefined) {
      return null;
    }

    return {
      userId,
      promptVersionId: createHash('sha256')
        .update(prepared.systemPrompt)
        .digest('hex')
        .slice(0, 16),
      model: routes[0]?.modelName ?? 'unknown',
      query: content,
      toolsEnabled: prepared.tools.length > 0,
    };
  }

  async handleMessage(
    userId: string,
    conversationId: string,
    content: string,
  ): Promise<ChatReply> {
    const prepared = await this.prepareMessage(userId, conversationId, content);
    await this.assertPaidToolsAllowed(userId, prepared);

    this.logAgentContext(
      userId,
      conversationId,
      prepared.skills.map((skill) => skill.id),
    );

    const selected = await this.llmRouterService.selectRoutes('chat');
    const decision = this.routeDecision(selected, content, prepared);
    const routes = decision.routes;
    const maskRef: { current: PiiMaskResult | null } = { current: null };
    const cacheQuery = this.cacheQuery(userId, content, prepared, routes);

    if (cacheQuery !== null) {
      const cached = await this.semanticCache!.lookup(cacheQuery);

      if (cached.hit) {
        await this.persistReply(conversationId, cached.reply);
        await this.rememberExchange(userId, content, cached.reply);

        return { conversationId, reply: cached.reply, cacheHit: true };
      }
    }

    try {
      const result = await this.consumeWorkerStream(
        this.worker.run(
          this.runRequest(userId, conversationId, prepared, routes, maskRef),
        ),
        conversationId,
      );

      if (result.pendingApproval) {
        return { conversationId, reply: '', pendingApproval: true };
      }

      const reply = this.restorePii(result.reply, maskRef.current);

      if (cacheQuery !== null) {
        await this.semanticCache!.store(cacheQuery, reply);
      }
      const metadata: AssistantMetadata = {
        ...(result.artifacts.length > 0
          ? {
              artifacts: result.artifacts.map((artifact) => ({
                ...artifact,
                content: this.restorePii(artifact.content, maskRef.current),
              })),
            }
          : {}),
        ...(result.executionTrace.length > 0
          ? { executionTrace: result.executionTrace }
          : {}),
        ...(prepared.citations.length > 0
          ? { citations: prepared.citations }
          : {}),
        ...(maskRef.current === null
          ? {}
          : { piiMaskedCount: maskRef.current.maskedCount }),
        ...(decision.modelTier === undefined
          ? {}
          : { modelTier: decision.modelTier }),
      };
      await this.persistReply(conversationId, reply, metadata);
      await this.rememberExchange(userId, content, reply);

      return { conversationId, reply, ...metadata };
    } catch (error) {
      if (!isInsufficientFunds(error)) {
        throw error;
      }

      const reply = ERROR_KEYS.insufficientFunds;

      await this.persistReply(conversationId, reply);

      return { conversationId, reply };
    }
  }

  async streamMessage(
    userId: string,
    conversationId: string,
    content: string,
    onDelta: (text: string) => void,
    onOfficeEvent?: (event: OfficeEvent) => void,
  ): Promise<ChatReply> {
    const prepared = await this.prepareMessage(userId, conversationId, content);
    await this.assertPaidToolsAllowed(userId, prepared);

    this.logAgentContext(
      userId,
      conversationId,
      prepared.skills.map((skill) => skill.id),
    );

    const selected = await this.llmRouterService.selectRoutes('chat');
    const decision = this.routeDecision(selected, content, prepared);
    const routes = decision.routes;
    const maskRef: { current: PiiMaskResult | null } = { current: null };
    const cacheQuery = this.cacheQuery(userId, content, prepared, routes);

    if (cacheQuery !== null) {
      const cached = await this.semanticCache!.lookup(cacheQuery);

      if (cached.hit) {
        onDelta(cached.reply);
        await this.persistReply(conversationId, cached.reply);
        await this.rememberExchange(userId, content, cached.reply);

        return { conversationId, reply: cached.reply, cacheHit: true };
      }
    }

    try {
      const result = await this.consumeWorkerStream(
        this.worker.run(
          this.runRequest(userId, conversationId, prepared, routes, maskRef),
        ),
        conversationId,
        onDelta,
        onOfficeEvent,
      );

      if (result.pendingApproval) {
        return { conversationId, reply: result.reply, pendingApproval: true };
      }

      const reply = this.restorePii(result.reply, maskRef.current);

      if (cacheQuery !== null) {
        await this.semanticCache!.store(cacheQuery, reply);
      }
      const metadata: AssistantMetadata = {
        ...(result.artifacts.length > 0
          ? {
              artifacts: result.artifacts.map((artifact) => ({
                ...artifact,
                content: this.restorePii(artifact.content, maskRef.current),
              })),
            }
          : {}),
        ...(result.executionTrace.length > 0
          ? { executionTrace: result.executionTrace }
          : {}),
        ...(prepared.citations.length > 0
          ? { citations: prepared.citations }
          : {}),
        ...(maskRef.current === null
          ? {}
          : { piiMaskedCount: maskRef.current.maskedCount }),
        ...(decision.modelTier === undefined
          ? {}
          : { modelTier: decision.modelTier }),
      };
      await this.persistReply(conversationId, reply, metadata);
      await this.rememberExchange(userId, content, reply);

      return { conversationId, reply, ...metadata };
    } catch (error) {
      if (!isInsufficientFunds(error)) {
        throw error;
      }

      const reply = ERROR_KEYS.insufficientFunds;
      onDelta(reply);

      return { conversationId, reply };
    }
  }

  /** Выбор маршрутов с учётом каскада моделей (CASCADE-44.1). */
  private routeDecision(
    selected: readonly LlmRouteSelection[],
    prompt: string,
    prepared: PreparedMessage,
  ): { routes: LlmRouteSelection[]; modelTier?: ModelTier } {
    if (this.cascade === undefined) {
      return { routes: [...selected] };
    }

    const decision = this.cascade.apply(
      selected,
      prompt,
      prepared.tools.length > 0,
    );

    return { routes: [...decision.routes], modelTier: decision.modelTier };
  }

  /** Локальная подстановка ПДн в уже полученном ответе (PII-44.2). */
  private restorePii(
    text: string,
    masked: PiiMaskResult | null,
  ): string {
    return masked === null || this.pii === undefined
      ? text
      : this.pii.unmaskPii(text, masked.tokensMap);
  }

  /**
   * Маскирует только данные, уходящие в llm-worker. mapping живёт в `maskRef`
   * в рамках одного вызова и никогда не попадает в БД/Redis/логи (PII-44.1).
   */
  private maskForWorker(
    prepared: PreparedMessage,
    maskRef?: { current: PiiMaskResult | null },
  ): { messages: HistoryMessage[]; memoryContext: string; systemPrompt: string } {
    if (this.pii === undefined || !this.pii.enabled || maskRef === undefined) {
      return {
        messages: prepared.messages,
        memoryContext: prepared.memoryContext,
        systemPrompt: prepared.systemPrompt,
      };
    }

    const state = { map: new Map<string, string>(), counters: new Map<string, number>() };
    const systemPrompt = this.pii.maskPii(prepared.systemPrompt, state).maskedText;
    const memoryContext = this.pii.maskPii(prepared.memoryContext, state).maskedText;
    const messages = prepared.messages.map((message) => ({
      role: message.role,
      content: this.pii!.maskPii(message.content, state).maskedText,
    }));

    maskRef.current = {
      maskedText: '',
      tokensMap: state.map,
      maskedCount: state.map.size,
    };

    return { messages, memoryContext, systemPrompt };
  }

  private runRequest(
    userId: string,
    conversationId: string,
    prepared: PreparedMessage,
    routes: readonly LlmRouteSelection[],
    maskRef?: { current: PiiMaskResult | null },
  ): RunGraphRequest {
    const outbound = this.maskForWorker(prepared, maskRef);

    return {
      conversationId,
      userId,
      messages: outbound.messages,
      skills: prepared.skills,
      approvalRequiredTools: prepared.approvalRequiredTools,
      approvalRules: prepared.approvalRules,
      outcomePrices: prepared.outcomePrices,
      llmRoutes: [...routes],
      memoryContext: outbound.memoryContext,
      userRole: prepared.userRole,
      toolSkills: prepared.toolSkills,
      taintedSecrets: [],
      systemPrompt: outbound.systemPrompt,
      tools: prepared.tools,
      agentId: DEFAULT_OFFICE_AGENT_ID,
      ...(prepared.skills.length === 0
        ? {}
        : { skillId: prepared.skills.map((skill) => skill.id).join(',') }),
      ...mergeCustomAgentRoles(
        orchestrationFromSkills(prepared.skills),
        prepared.customRoles,
      ),
      traceId: randomUUID(),
    };
  }

  private async consumeWorkerStream(
    events: AsyncIterable<GraphEvent>,
    conversationId: string,
    onDelta?: (text: string) => void,
    onOfficeEvent?: (event: OfficeEvent) => void,
  ): Promise<StreamResult> {
    let reply = '';
    let pendingApproval = false;
    let artifacts: ArtifactItem[] = [];
    let executionTrace: ExecutionStep[] = [];

    for await (const event of events) {
      switch (event.type) {
        case 'delta':
          reply += event.text;
          onDelta?.(event.text);
          break;
        case 'office':
          onOfficeEvent?.({
            conversationId,
            agentId: event.agentId,
            status: event.status,
            task: event.task,
            ...(event.reason === undefined ? {} : { reason: event.reason }),
          });
          break;
        case 'approval':
          pendingApproval = true;
          onOfficeEvent?.({
            conversationId,
            agentId: DEFAULT_OFFICE_AGENT_ID,
            status: 'waiting_approval',
            task: event.task,
            reason: event.reason,
          });
          break;
        case 'done':
          reply = event.reply;
          pendingApproval = event.pendingApproval;
          artifacts = event.artifacts ?? [];
          executionTrace = event.executionTrace ?? [];
          break;
        default:
          break;
      }
    }

    // Worker может не передать артефакты явно — тогда их извлекаем из текста.
    const parsed = parseArtifacts(reply);

    return {
      reply: parsed.cleanText,
      pendingApproval,
      artifacts: artifacts.length > 0 ? artifacts : parsed.artifacts,
      executionTrace,
    };
  }

  /** Проверяет диалог, баланс, сохраняет вопрос и собирает контекст. */
  private async prepareMessage(
    userId: string,
    conversationId: string,
    content: string,
  ): Promise<PreparedMessage> {
    await this.assertConversationOwner(userId, conversationId);
    await this.discardStaleApproval(conversationId);
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
      .map((message) => toHistoryMessage(message.role, message.content));

    // Долговременная память: top-K фрагментов под последний вопрос.
    // Ошибки внутри MemoryService не прерывают диалог.
    const memory = await this.loadMemory(userId, content);

    return this.buildContext(
      userId,
      messages,
      memory.context,
      conversationId,
      memory.citations,
    );
  }

  /** Контекст памяти + сноски; совместим с моками старого buildContext. */
  private async loadMemory(
    userId: string,
    content: string,
  ): Promise<{ context: string; citations: Citation[] }> {
    const withSources = this.memoryService.buildContextWithSources;

    if (typeof withSources !== 'function') {
      return { context: await this.memoryService.buildContext(userId, content), citations: [] };
    }

    const result = await withSources.call(this.memoryService, userId, content);

    return {
      context: result.context,
      citations: result.chunks.map((chunk, index) => ({
        index: index + 1,
        chunkId: chunk.id,
        title: chunk.title ?? chunk.source ?? 'Документ',
        snippet: chunk.content.slice(0, 200),
        ...(chunk.pageNumber === null || chunk.pageNumber === undefined
          ? {}
          : { pageNumber: chunk.pageNumber }),
      })),
    };
  }

  /** Контекст запуска/resume графа без записи сообщения пользователя. */
  private async buildGraphContext(
    userId: string,
    conversationId: string,
  ): Promise<Omit<PreparedMessage, 'messages'>> {
    // Memory-контекст уже лежит в состоянии графа (checkpoint), поэтому при
    // resume его повторно не подбираем: важен только вопрос, а он был учтён
    // при запуске. Вариант A/B-промпта должен оставаться тем же — общий
    // conversationId обеспечивает детерминированный выбор (WEB-28.1).
    return this.buildContext(userId, [], '', conversationId);
  }

  private async buildContext(
    userId: string,
    messages: HistoryMessage[],
    memoryContext: string,
    conversationId?: string,
    citations: Citation[] = [],
  ): Promise<PreparedMessage> {
    const skills = (await this.skillsService.getEnabledSkills()).map(
      (skill): SkillSnapshot => ({
        id: skill.id,
        name: skill.name,
        manifest: skill.manifest,
        isEnabled: skill.isEnabled,
      }),
    );
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    const userRole = normalizeUserRole(user?.role);
    const customRoles = await this.loadCustomRoles(userId);
    const systemPrompt =
      withMemoryContext(
        await this.promptsService.getActiveSystemPrompt(
          undefined,
          conversationId,
        ),
        memoryContext,
      ) + customRolesPrompt(customRoles);

    return {
      messages,
      skills,
      customRoles,
      approvalRequiredTools: resolveApprovalTools(skills),
      approvalRules: resolveApprovalRules(skills),
      outcomePrices: resolveOutcomePrices(skills),
      memoryContext,
      citations,
      userRole,
      toolSkills: buildToolSkillContexts(skills),
      systemPrompt,
      tools: this.toolsService.buildDescriptors(skills),
    };
  }

  /** Подхватывает активные кастомные роли дефолтного воркспейса пользователя. */
  private async loadCustomRoles(
    userId: string,
  ): Promise<CustomAgentRoleContext[]> {
    if (this.workspaces === undefined) {
      return [];
    }

    const active = await this.workspaces.resolveActive(userId, undefined);

    if (active === null) {
      return [];
    }

    const rows = await this.prisma.customAgentRole.findMany({
      where: { workspaceId: active.workspaceId, isActive: true },
      select: {
        roleKey: true,
        name: true,
        systemPrompt: true,
        skillSlugs: true,
        hitlPolicy: true,
        dailyBudgetRub: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    return customAgentRoleContextSchema.array().parse(
      rows.map((row) => ({
        ...row,
        dailyBudgetRub: row.dailyBudgetRub?.toNumber() ?? null,
      })),
    );
  }

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

  /** Отменяет «зависшее» одобрение при новом сообщении в том же диалоге. */
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
    await this.checkpoints.deleteThread(conversationId);

    this.logger.log(
      `Отменено устаревшее ожидание одобрения: conversationId=${conversationId}`,
    );
  }

  private async persistReply(
    conversationId: string,
    reply: string,
    metadata: AssistantMetadata = {},
  ): Promise<void> {
    const parsedMetadata = assistantMetadataSchema.parse(metadata);
    const hasMetadata = Object.keys(parsedMetadata).length > 0;

    await this.prisma.message.create({
      data: {
        conversationId,
        role: 'assistant',
        content: reply,
        ...(hasMetadata
          ? {
              metadataJson: parsedMetadata as unknown as Prisma.InputJsonValue,
            }
          : {}),
      },
    });
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });
  }

  private async rememberReply(userId: string, reply: string): Promise<void> {
    if (reply.trim() === '') {
      return;
    }

    try {
      await this.memoryService.remember(userId, reply);
    } catch (error) {
      this.logger.warn(
        `Не удалось обновить долговременную память: ${describe(error)}`,
      );
    }
  }

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
        `Не удалось обновить долговременную память: ${describe(error)}`,
      );
    }
  }

  private async assertSufficientBalance(userId: string): Promise<void> {
    const { balance } = await this.billingService.getBalance(userId);

    if (Number.parseFloat(balance) < MIN_AGENT_BALANCE) {
      throw insufficientFundsError(ERROR_KEYS.insufficientFunds);
    }
  }

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
        executor: 'llm-worker',
      }),
    );
  }
}

function toHistoryMessage(role: string, content: string): HistoryMessage {
  if (role === 'assistant' || role === 'system') {
    return { role, content };
  }

  return { role: 'user', content };
}

function isInsufficientFunds(error: unknown): boolean {
  return (
    error instanceof ApiException &&
    error.getResponse().code === ERROR_KEYS.insufficientFunds
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
