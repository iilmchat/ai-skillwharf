import { Injectable, Logger } from '@nestjs/common';
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import {
  DynamicStructuredTool,
  type StructuredToolInterface,
} from '@langchain/core/tools';
import { ChatOpenAI } from '@langchain/openai';
import { z } from 'zod';
import { SandboxService } from '../sandbox/sandbox.service.js';

export interface ChatHistoryMessage {
  role: string;
  content: string;
}

/** Имя инструмента песочницы, которым LLM может вызвать выполнение кода. */
export const SANDBOX_TOOL_NAME = 'execute_sandbox_code';

/** Описание инструмента для LLM. */
export const SANDBOX_TOOL_DESCRIPTION =
  'Выполняет код на Python/Shell в изолированной среде и возвращает результат';

/** Схема аргументов инструмента песочницы. */
export const SandboxToolSchema = z.object({
  code: z.string().describe('Код для выполнения'),
});

/**
 * Секреты из окружения Gateway, которые разрешено передавать в песочницу.
 * Список ограничен: произвольные переменные процесса в контейнер не попадают.
 */
export const SANDBOX_ENV_ALLOWLIST = ['TAVILY_API_KEY', 'GITHUB_TOKEN'] as const;

export interface SandboxToolOptions {
  /**
   * Хук перед выполнением кода (paywall). Если он выбрасывает исключение,
   * код в песочнице не запускается.
   */
  beforeExecute?: () => Promise<void>;
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

  constructor(private readonly sandboxService: SandboxService) {
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

  /**
   * Инструмент LangChain `execute_sandbox_code`: запускает код через
   * SandboxService. `beforeExecute` вызывается до запуска и используется
   * для списания средств (paywall).
   */
  createSandboxTool(options: SandboxToolOptions = {}): DynamicStructuredTool {
    return new DynamicStructuredTool({
      name: SANDBOX_TOOL_NAME,
      description: SANDBOX_TOOL_DESCRIPTION,
      schema: SandboxToolSchema,
      func: async ({ code }) => {
        await options.beforeExecute?.();

        return this.sandboxService.runCommand(code, sandboxEnv());
      },
    });
  }

  async chat(messages: ChatHistoryMessage[]): Promise<string> {
    const response = await this.chatWithTools(
      messages.map(toLangChainMessage),
      [],
    );

    return messageContentToText(response.content);
  }

  /**
   * Вызов LLM с набором инструментов. Возвращает ответ модели как есть:
   * если в нём есть `tool_calls`, их должен выполнить вызывающий граф.
   */
  async chatWithTools(
    messages: BaseMessage[],
    tools: StructuredToolInterface[],
  ): Promise<AIMessage> {
    if (!this.client) {
      const lastUserMessage = [...messages]
        .reverse()
        .find((message) => message instanceof HumanMessage);

      return new AIMessage(
        `LLM not configured: ${messageContentToText(lastUserMessage?.content ?? '')}`,
      );
    }

    const model =
      tools.length > 0 ? this.client.bindTools(tools) : this.client;

    return model.invoke(messages);
  }
}

/** Собирает разрешённые секреты из окружения Gateway для песочницы. */
function sandboxEnv(): Record<string, string> {
  const env: Record<string, string> = {};

  for (const key of SANDBOX_ENV_ALLOWLIST) {
    const value = process.env[key];

    if (value) {
      env[key] = value;
    }
  }

  return env;
}

/** Приводит контент сообщения LangChain к строке. */
export function messageContentToText(content: BaseMessage['content']): string {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

export function toLangChainMessage(message: ChatHistoryMessage): BaseMessage {
  switch (message.role) {
    case 'assistant':
      return new AIMessage(message.content);
    case 'system':
      return new SystemMessage(message.content);
    default:
      return new HumanMessage(message.content);
  }
}
