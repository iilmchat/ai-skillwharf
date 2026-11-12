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
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
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
        content:
          typeof result === 'string' ? result : JSON.stringify(result),
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
    .addNode('llm', async (state: ChatState) => {
      const response = await llmService.chatWithTools(
        state.messages,
        state.availableTools,
      );
      const calls = response.tool_calls ?? [];
      const limitReached = toolRounds(state.messages) >= MAX_TOOL_ROUNDS;
      const text = messageContentToText(response.content);

      return {
        messages: [...state.messages, response],
        reply:
          calls.length > 0 && !limitReached
            ? ''
            : text || (limitReached ? TOOL_LIMIT_REPLY : ''),
      };
    })
    .addNode('tools', async (state: ChatState) => ({
      messages: [
        ...state.messages,
        ...(await executeToolCalls(
          state.availableTools,
          toolCallsOf(lastMessage(state.messages)),
        )),
      ],
    }))
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

    let reply: string;

    try {
      const state = await this.graph.invoke({ messages, availableTools: tools });
      reply = state.reply;
    } catch (error) {
      // Paywall: списание не удалось — песочница не запускалась,
      // прерываем граф и отдаём клиенту ключ ошибки для перевода.
      if (!(error instanceof BadRequestException)) {
        throw error;
      }

      reply = ERROR_KEYS.insufficientFunds;
    }

    await this.prisma.message.create({
      data: { conversationId, role: 'assistant', content: reply },
    });
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });

    return { conversationId, reply };
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
  private async buildTools(
    userId: string,
  ): Promise<StructuredToolInterface[]> {
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
