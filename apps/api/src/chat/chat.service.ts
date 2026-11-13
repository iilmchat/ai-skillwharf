import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { InstalledSkill } from '@prisma/client';
import { SkillManifestSchema } from '@skillwharf/shared';
import { BillingService } from '../billing/billing.service.js';
import { ERROR_KEYS } from '../i18n/error-keys.js';
import { MemoryService } from '../memory/memory.service.js';
import { PromptsService } from '../prompts/prompts.service.js';
import type { UserRole } from '../security/policy/policy.types.js';
import { SkillsService } from '../skills/skills.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  LlmRouterService,
  type LlmRouteSelection,
} from '../llm-router/llm-router.service.js';
import { ApiException } from '../common/api-error.js';
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
import type { GraphEvent, OutcomePrice, ResumeGraphRequest, RunGraphRequest } from '../agent/contracts.js';
import { LlmWorkerClient } from '../agent/llm-worker.client.js';

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
}

interface HistoryMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface PreparedMessage {
  messages: HistoryMessage[];
  skills: SkillSnapshot[];
  approvalRequiredTools: string[];
  outcomePrices: Record<string, OutcomePrice>;
  memoryContext: string;
  userRole: UserRole;
  toolSkills: Record<string, WorkerToolSkillContext[]>;
  systemPrompt: string;
  tools: ReturnType<AgentToolsService['buildDescriptors']>;
}

interface StreamResult {
  reply: string;
  pendingApproval: boolean;
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
  ): Promise<ChatReply | null> {
    await this.assertConversationOwner(userId, conversationId);

    const pending =
      await this.pendingApprovalService.findPending(conversationId);

    if (pending === null || pending.userId !== userId) {
      return null;
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

  async handleMessage(
    userId: string,
    conversationId: string,
    content: string,
  ): Promise<ChatReply> {
    const prepared = await this.prepareMessage(userId, conversationId, content);

    this.logAgentContext(
      userId,
      conversationId,
      prepared.skills.map((skill) => skill.id),
    );

    const routes = await this.llmRouterService.selectRoutes('chat');

    try {
      const result = await this.consumeWorkerStream(
        this.worker.run(
          this.runRequest(userId, conversationId, prepared, routes),
        ),
        conversationId,
      );

      if (result.pendingApproval) {
        return { conversationId, reply: '', pendingApproval: true };
      }

      await this.persistReply(conversationId, result.reply);
      await this.rememberExchange(userId, content, result.reply);

      return { conversationId, reply: result.reply };
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

    this.logAgentContext(
      userId,
      conversationId,
      prepared.skills.map((skill) => skill.id),
    );

    const routes = await this.llmRouterService.selectRoutes('chat');

    try {
      const result = await this.consumeWorkerStream(
        this.worker.run(
          this.runRequest(userId, conversationId, prepared, routes),
        ),
        conversationId,
        onDelta,
        onOfficeEvent,
      );

      if (result.pendingApproval) {
        return { conversationId, reply: result.reply, pendingApproval: true };
      }

      await this.persistReply(conversationId, result.reply);
      await this.rememberExchange(userId, content, result.reply);

      return { conversationId, reply: result.reply };
    } catch (error) {
      if (!isInsufficientFunds(error)) {
        throw error;
      }

      const reply = ERROR_KEYS.insufficientFunds;
      onDelta(reply);

      return { conversationId, reply };
    }
  }

  private runRequest(
    userId: string,
    conversationId: string,
    prepared: PreparedMessage,
    routes: LlmRouteSelection[],
  ): RunGraphRequest {
    return {
      conversationId,
      userId,
      messages: prepared.messages,
      skills: prepared.skills,
      approvalRequiredTools: prepared.approvalRequiredTools,
      outcomePrices: prepared.outcomePrices,
      llmRoutes: routes,
      memoryContext: prepared.memoryContext,
      userRole: prepared.userRole,
      toolSkills: prepared.toolSkills,
      taintedSecrets: [],
      systemPrompt: prepared.systemPrompt,
      tools: prepared.tools,
      agentId: DEFAULT_OFFICE_AGENT_ID,
      ...(prepared.skills.length === 0
        ? {}
        : { skillId: prepared.skills.map((skill) => skill.id).join(',') }),
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
          break;
        default:
          break;
      }
    }

    return { reply, pendingApproval };
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
    const memoryContext = await this.memoryService.buildContext(userId, content);

    return this.buildContext(userId, messages, memoryContext);
  }

  /** Контекст запуска/resume графа без записи сообщения пользователя. */
  private async buildGraphContext(
    userId: string,
    conversationId: string,
  ): Promise<Omit<PreparedMessage, 'messages'>> {
    void conversationId;

    // Memory-контекст уже лежит в состоянии графа (checkpoint), поэтому при
    // resume его повторно не подбираем: важен только вопрос, а он был учтён
    // при запуске.
    return this.buildContext(userId, [], '');
  }

  private async buildContext(
    userId: string,
    messages: HistoryMessage[],
    memoryContext: string,
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
    const systemPrompt = withMemoryContext(
      await this.promptsService.getActiveSystemPrompt(),
      memoryContext,
    );

    return {
      messages,
      skills,
      approvalRequiredTools: resolveApprovalTools(skills),
      outcomePrices: resolveOutcomePrices(skills),
      memoryContext,
      userRole,
      toolSkills: buildToolSkillContexts(skills),
      systemPrompt,
      tools: this.toolsService.buildDescriptors(skills),
    };
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
  ): Promise<void> {
    await this.prisma.message.create({
      data: { conversationId, role: 'assistant', content: reply },
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
      throw new BadRequestException(ERROR_KEYS.insufficientFunds);
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
