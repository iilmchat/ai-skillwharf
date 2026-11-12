import { Injectable, NotFoundException } from '@nestjs/common';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { LlmService, type ChatHistoryMessage } from '../llm/llm.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** Сколько последних сообщений диалога передаём в LLM. */
export const CHAT_HISTORY_LIMIT = 10;

const ChatStateAnnotation = Annotation.Root({
  messages: Annotation<ChatHistoryMessage[]>({
    reducer: (_previous, next) => next,
    default: () => [],
  }),
  reply: Annotation<string>({
    reducer: (_previous, next) => next,
    default: () => '',
  }),
});

type ChatState = typeof ChatStateAnnotation.State;

export interface ChatReply {
  conversationId: string;
  reply: string;
}

/**
 * Граф состояний LangGraph: единственный узел `llm` вызывает LLM-сервис.
 * Историю диалога (последние CHAT_HISTORY_LIMIT сообщений) передаём как состояние.
 */
function buildChatGraph(llmService: LlmService) {
  return new StateGraph(ChatStateAnnotation)
    .addNode('llm', async (state: ChatState): Promise<{ reply: string }> => ({
      reply: await llmService.chat(state.messages),
    }))
    .addEdge(START, 'llm')
    .addEdge('llm', END)
    .compile();
}

@Injectable()
export class ChatService {
  private readonly graph: ReturnType<typeof buildChatGraph>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly llmService: LlmService,
  ) {
    this.graph = buildChatGraph(this.llmService);
  }

  async handleMessage(conversationId: string, content: string): Promise<ChatReply> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { id: true },
    });

    if (!conversation) {
      throw new NotFoundException(`Диалог ${conversationId} не найден`);
    }

    await this.prisma.message.create({
      data: { conversationId, role: 'user', content },
    });

    const latestMessages = await this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      take: CHAT_HISTORY_LIMIT,
      select: { role: true, content: true },
    });

    const state = await this.graph.invoke({
      messages: latestMessages.reverse(),
    });

    await this.prisma.message.create({
      data: { conversationId, role: 'assistant', content: state.reply },
    });
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { updatedAt: new Date() },
    });

    return { conversationId, reply: state.reply };
  }
}
