import { Injectable, Logger } from '@nestjs/common';
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';

export interface ChatHistoryMessage {
  role: string;
  content: string;
}

/**
 * Клиент к OpenAI-совместимому LLM-серверу.
 *
 * Если `LLM_BASE_URL`/`LLM_MODEL` не заданы, сервис работает как заглушка:
 * возвращает `LLM not configured: <последнее сообщение пользователя>`.
 * Это позволяет запускать приложение и тесты без реальных ключей.
 */
@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private readonly client: ChatOpenAI | null;

  constructor() {
    const baseURL = process.env.LLM_BASE_URL;
    const model = process.env.LLM_MODEL;

    if (!baseURL || !model) {
      this.client = null;
      this.logger.warn(
        'LLM не настроен (LLM_BASE_URL/LLM_MODEL) — используется эхо-заглушка',
      );
      return;
    }

    this.client = new ChatOpenAI({
      model,
      apiKey: process.env.LLM_API_KEY || 'not-needed',
      configuration: { baseURL },
      temperature: 0.7,
    });
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  async chat(messages: ChatHistoryMessage[]): Promise<string> {
    const lastUserMessage =
      [...messages].reverse().find((message) => message.role === 'user')
        ?.content ?? '';

    if (!this.client) {
      return `LLM not configured: ${lastUserMessage}`;
    }

    const response = await this.client.invoke(messages.map(toLangChainMessage));

    return typeof response.content === 'string'
      ? response.content
      : JSON.stringify(response.content);
  }
}

function toLangChainMessage(message: ChatHistoryMessage): BaseMessage {
  switch (message.role) {
    case 'assistant':
      return new AIMessage(message.content);
    case 'system':
      return new SystemMessage(message.content);
    default:
      return new HumanMessage(message.content);
  }
}
