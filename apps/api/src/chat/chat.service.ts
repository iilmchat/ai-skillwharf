import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  AIMessage,
  type BaseMessage,
  ToolMessage,
  type ToolCall,
} from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { BillingService } from '../billing/billing.service.js';
import {
  LlmService,
  messageContentToText,
  toLangChainMessage,
} from '../llm/llm.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** Сколько последних сообщений диалога передаём в LLM. */
export const CHAT_HISTORY_LIMIT = 10;

/** Стоимость одного вызова песочницы (paywall). */
export const SANDBOX_CALL_PRICE = 0.1;

/** Описание списания в Ledger. */
export const SANDBOX_CALL_DESCRIPTION = 'Выполнение кода в песочнице';

/** Сколько раз за один ответ разрешено запускать инструменты. */
export const MAX_TOOL_ROUNDS = 5;

/** Ответ пользователю, если на балансе не хватает средств. */
export const INSUFFICIENT_FUNDS_REPLY =
  'Недостаточно средств для выполнения кода. Пополните баланс.';

/** Минимальный баланс, с которым разрешено запускать агента. */
export const MIN_AGENT_BALANCE = 0.5;

/** Ошибка, если баланса не хватает на запуск агента. */
export const INSUFFICIENT_BALANCE_MESSAGE =
  'Недостаточно средств для запуска агента. Пополните баланс.';

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

    const tools = this.buildTools(userId);

    let reply: string;

    try {
      const state = await this.graph.invoke({ messages, availableTools: tools });
      reply = state.reply;
    } catch (error) {
      // Paywall: списание не удалось — песочница не запускалась,
      // прерываем граф и объясняем пользователю причину.
      if (!(error instanceof BadRequestException)) {
        throw error;
      }

      reply = INSUFFICIENT_FUNDS_REPLY;
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
      throw new BadRequestException(INSUFFICIENT_BALANCE_MESSAGE);
    }
  }

  /**
   * Инструменты, доступные агенту. Каждый запуск песочницы оплачивается,
   * поэтому у всех инструментов общий paywall-хук.
   */
  private buildTools(userId: string): StructuredToolInterface[] {
    const beforeExecute = async (): Promise<void> => {
      await this.billingService.chargeForSkill(
        userId,
        SANDBOX_CALL_PRICE,
        SANDBOX_CALL_DESCRIPTION,
        randomUUID(),
      );
    };

    return [
      this.llmService.createSandboxTool({ beforeExecute }),
      this.llmService.createWebSearchTool({ beforeExecute }),
      this.llmService.createExecTool({ beforeExecute }),
    ];
  }
}
