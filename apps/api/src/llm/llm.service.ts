import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  AIMessage,
  AIMessageChunk,
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
import type { LlmRouteSelection } from '../llm-router/llm-router.service.js';
import { DEFAULT_SYSTEM_PROMPT } from '../prompts/default-prompt.js';
import type { PromptsService } from '../prompts/prompts.service.js';
import {
  SANDBOX_NETWORK_FLAG,
  SandboxService,
} from '../sandbox/sandbox.service.js';

export interface ChatHistoryMessage {
  role: string;
  content: string;
}

/**
 * Элемент стрима ответа модели: `delta` — очередной фрагмент текста,
 * `message` — готовое сообщение с `tool_calls` (последний элемент итератора).
 */
export type ChatStreamChunk =
  { type: 'delta'; text: string } | { type: 'message'; message: AIMessage };

/** Имя инструмента песочницы, которым LLM может вызвать выполнение кода. */
export const SANDBOX_TOOL_NAME = 'execute_sandbox_code';

/** Описание инструмента для LLM. */
export const SANDBOX_TOOL_DESCRIPTION =
  'Выполняет код на Python/Shell в изолированной среде и возвращает результат';

/** Схема аргументов инструмента песочницы. */
export const SandboxToolSchema = z.object({
  code: z.string().describe('Код для выполнения'),
});

/** Имя инструмента поиска в интернете. */
export const WEB_SEARCH_TOOL_NAME = 'web_search';

/** Описание инструмента поиска для LLM. */
export const WEB_SEARCH_TOOL_DESCRIPTION =
  'Ищет актуальную информацию в интернете через Tavily и возвращает результаты';

/** Схема аргументов инструмента поиска. */
export const WebSearchToolSchema = z.object({
  query: z.string().describe('Поисковый запрос'),
});

/** Имя инструмента выполнения shell-команд. */
export const EXEC_TOOL_NAME = 'exec';

/** Описание инструмента `exec` для LLM. */
export const EXEC_TOOL_DESCRIPTION =
  'Выполняет shell-команду в изолированной среде и возвращает stdout';

/** Схема аргументов инструмента `exec`. */
export const ExecToolSchema = z.object({
  command: z.string().describe('Shell-команда для выполнения'),
});

/** Имя MCP-инструмента Ozon. */
export const OZON_MCP_TOOL_NAME = 'ozon_mcp_call';

/** Описание MCP-инструмента Ozon для LLM. */
export const OZON_MCP_TOOL_DESCRIPTION =
  'Вызывает MCP-инструмент Ozon Seller: карточки, заказы, продажи и отзывы';

/** Имя MCP-инструмента Wildberries. */
export const WB_MCP_TOOL_NAME = 'wb_mcp_call';

/** Описание MCP-инструмента Wildberries для LLM. */
export const WB_MCP_TOOL_DESCRIPTION =
  'Вызывает MCP-инструмент Wildberries Seller: карточки, заказы, продажи и отзывы';

/** Схема аргументов marketplace MCP-инструментов. */
export const McpToolSchema = z.object({
  action: z.string().describe('Действие MCP-инструмента'),
  params: z.record(z.string(), z.any()).describe('Параметры действия'),
});

/** Инструкция по умолчанию живёт в prompts/default-prompt.ts. */

/**
 * Запрос к Tavily. Тело собирается в JSON в Gateway и передаётся в песочницу
 * переменной окружения, поэтому пользовательский запрос не попадает в
 * shell-строку и не может её сломать.
 */
const TAVILY_SEARCH_COMMAND =
  "curl -sS -X POST 'https://api.tavily.com/search' -H 'Content-Type: application/json' -d \"$TAVILY_REQUEST_BODY\"";

/**
 * Секреты из окружения Gateway, которые разрешено передавать в песочницу.
 * Список ограничен: произвольные переменные процесса в контейнер не попадают.
 */
export const SANDBOX_ENV_ALLOWLIST = [
  'TAVILY_API_KEY',
  'GITHUB_TOKEN',
] as const;

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

  constructor(
    private readonly sandboxService: SandboxService,
    @Optional() private readonly promptsService?: PromptsService,
  ) {
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

  /**
   * Инструмент `web_search`: ищет через Tavily API в песочнице. Тело запроса
   * сериализуется в JSON здесь, а ключ берётся из `TAVILY_API_KEY`.
   */
  createWebSearchTool(options: SandboxToolOptions = {}): DynamicStructuredTool {
    return new DynamicStructuredTool({
      name: WEB_SEARCH_TOOL_NAME,
      description: WEB_SEARCH_TOOL_DESCRIPTION,
      schema: WebSearchToolSchema,
      func: async ({ query }) => {
        const apiKey = process.env.TAVILY_API_KEY;

        if (!apiKey) {
          return 'Ошибка: TAVILY_API_KEY не задан в окружении Gateway';
        }

        await options.beforeExecute?.();

        const requestBody = JSON.stringify({
          api_key: apiKey,
          query,
          search_depth: 'basic',
          max_results: 5,
        });

        return this.sandboxService.runCommand(TAVILY_SEARCH_COMMAND, {
          [SANDBOX_NETWORK_FLAG]: 'true',
          TAVILY_REQUEST_BODY: requestBody,
        });
      },
    });
  }

  /**
   * Инструмент `exec`: выполняет shell-команду в песочнице. Нужен навыкам
   * вроде `github`, которые работают через `gh` CLI.
   */
  createExecTool(options: SandboxToolOptions = {}): DynamicStructuredTool {
    return new DynamicStructuredTool({
      name: EXEC_TOOL_NAME,
      description: EXEC_TOOL_DESCRIPTION,
      schema: ExecToolSchema,
      func: async ({ command }) => {
        await options.beforeExecute?.();

        return this.sandboxService.runCommand(command, {
          ...sandboxEnv(),
          // `github` и подобные навыки требуют egress; сеть остаётся под
          // контролем SandboxService (флаг не попадает в контейнер).
          [SANDBOX_NETWORK_FLAG]: 'true',
        });
      },
    });
  }

  /**
   * MCP-заглушка Ozon: пока реальный MCP-сервер не подключён, инструмент
   * возвращает демонстрационные данные по запрошенному действию.
   */
  createOzonMcpTool(options: SandboxToolOptions = {}): DynamicStructuredTool {
    return this.createMarketplaceMcpTool(
      OZON_MCP_TOOL_NAME,
      OZON_MCP_TOOL_DESCRIPTION,
      'ozon',
      options,
    );
  }

  /** MCP-заглушка Wildberries. */
  createWbMcpTool(options: SandboxToolOptions = {}): DynamicStructuredTool {
    return this.createMarketplaceMcpTool(
      WB_MCP_TOOL_NAME,
      WB_MCP_TOOL_DESCRIPTION,
      'wb',
      options,
    );
  }

  private createMarketplaceMcpTool(
    name: string,
    description: string,
    platform: 'ozon' | 'wb',
    options: SandboxToolOptions,
  ): DynamicStructuredTool {
    return new DynamicStructuredTool({
      name,
      description,
      schema: McpToolSchema,
      func: async ({ action, params }) => {
        await options.beforeExecute?.();

        return mockMarketplaceResponse(platform, action, params);
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
    route?: LlmRouteSelection,
  ): Promise<AIMessage> {
    const client = this.resolveClient(route);

    if (!client) {
      const lastUserMessage = [...messages]
        .reverse()
        .find((message) => message instanceof HumanMessage);

      return new AIMessage(
        `LLM not configured: ${messageContentToText(lastUserMessage?.content ?? '')}`,
      );
    }

    const model = tools.length > 0 ? client.bindTools(tools) : client;
    const systemPrompt = await this.getSystemPrompt();

    return model.invoke(withLanguageInstruction(messages, systemPrompt));
  }

  /**
   * Стриминговый вариант `chatWithTools`: отдаёт текст по мере генерации.
   * Последним элементом итератора приходит собранное сообщение модели —
   * по нему граф решает, нужно ли запускать инструменты.
   */
  async *chatWithToolsStream(
    messages: BaseMessage[],
    tools: StructuredToolInterface[],
    route?: LlmRouteSelection,
  ): AsyncGenerator<ChatStreamChunk, void, unknown> {
    const client = this.resolveClient(route);

    if (!client) {
      const lastUserMessage = [...messages]
        .reverse()
        .find((message) => message instanceof HumanMessage);
      const text = `LLM not configured: ${messageContentToText(lastUserMessage?.content ?? '')}`;

      yield { type: 'delta', text };
      yield { type: 'message', message: new AIMessage(text) };
      return;
    }

    const model = tools.length > 0 ? client.bindTools(tools) : client;
    const systemPrompt = await this.getSystemPrompt();
    let accumulated: AIMessageChunk | undefined;

    for await (const chunk of await model.stream(
      withLanguageInstruction(messages, systemPrompt),
    )) {
      accumulated = accumulated ? accumulated.concat(chunk) : chunk;

      if (chunk.text) {
        yield { type: 'delta', text: chunk.text };
      }
    }

    const message = accumulated
      ? new AIMessage({
          content: accumulated.content,
          tool_calls: accumulated.tool_calls,
          invalid_tool_calls: accumulated.invalid_tool_calls,
          usage_metadata: accumulated.usage_metadata,
        })
      : new AIMessage('');

    yield { type: 'message', message };
  }

  /**
   * Клиент для выбранного маршрута или env-fallback. Ключ API берётся из
   * переменной окружения, имя которой хранится в маршруте.
   */
  private resolveClient(route?: LlmRouteSelection): ChatOpenAI | null {
    if (!route) {
      return this.client;
    }

    const modelName = route.modelName.trim();
    const baseURL = route.baseUrl.trim();

    if (!modelName || !baseURL) {
      return this.client;
    }

    const apiKey = route.apiKeyEnvVar
      ? process.env[route.apiKeyEnvVar]
      : process.env.LLM_API_KEY;

    return new ChatOpenAI({
      model: modelName,
      apiKey: apiKey || 'not-needed',
      configuration: { baseURL },
      temperature: 0.7,
    });
  }

  /** Активный системный промпт из БД; при сбое — дефолтная инструкция. */
  private async getSystemPrompt(): Promise<string> {
    if (!this.promptsService) {
      return DEFAULT_SYSTEM_PROMPT;
    }

    try {
      return await this.promptsService.getActiveSystemPrompt();
    } catch {
      return DEFAULT_SYSTEM_PROMPT;
    }
  }
}

/** Добавляет системную инструкцию в начало диалога. */
export function withLanguageInstruction(
  messages: BaseMessage[],
  systemPrompt: string = DEFAULT_SYSTEM_PROMPT,
): BaseMessage[] {
  return [new SystemMessage(systemPrompt), ...messages];
}

/**
 * Демо-ответ MCP-заглушки. Реальные Ozon/WB MCP-серверы ещё не подключены,
 * поэтому возвращаем предсказуемые данные для сценариев и тестов.
 */
function mockMarketplaceResponse(
  platform: 'ozon' | 'wb',
  action: string,
  params: unknown,
): string {
  const base = { platform, action, mock: true, params };

  switch (action) {
    case 'get_sales':
      return JSON.stringify({
        ...base,
        sales: 15000,
        items: 42,
        currency: 'RUB',
      });
    case 'get_orders':
      return JSON.stringify({
        ...base,
        orders: [{ id: 'order-1', status: 'delivered', amount: 2500 }],
        total: 42,
      });
    case 'get_products':
      return JSON.stringify({
        ...base,
        products: [{ id: 'product-1', name: 'Демо-товар', price: 1990 }],
        total: 42,
      });
    case 'update_product':
      return JSON.stringify({ ...base, updated: true });
    case 'get_reviews':
      return JSON.stringify({
        ...base,
        reviews: [{ id: 'review-1', rating: 5, text: 'Отличный товар' }],
        rating: 4.8,
      });
    case 'reply_review':
      return JSON.stringify({ ...base, replied: true });
    default:
      return JSON.stringify({ ...base, result: 'ok' });
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
