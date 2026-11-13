import {
  BadRequestException,
  HttpStatus,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
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
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { BillingService } from '../billing/billing.service.js';
import { ApiException } from '../common/api-error.js';
import { ERROR_KEYS } from '../i18n/error-keys.js';
import type { LlmRouteSelection } from '../llm-router/llm-router.service.js';
import {
  isNativeProviderType,
  normalizeProviderType,
} from '../llm-router/provider-type.js';
import { GigaChatAdapter } from './adapters/gigachat.adapter.js';
import type {
  NativeChatRequest,
  NativeProviderAdapter,
} from './adapters/types.js';
import { YandexAdapter } from './adapters/yandex.adapter.js';
import { DailyTokenLimitException } from './daily-token-limit.exception.js';
import {
  estimateMessagesTokens,
  estimateUsageFromMessages,
} from './token-estimator.js';
import { McpClient } from './tools/mcp-client.js';
import {
  McpGateway,
  mcpToolCallSchema,
  mcpUnavailableError,
  type McpProvider,
} from './tools/mcp-gateway.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { recordGenAiUsageSpan } from '../observability/tracing.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { DEFAULT_SYSTEM_PROMPT } from '../prompts/default-prompt.js';
import type { PromptsService } from '../prompts/prompts.service.js';
import { SandboxService } from '../sandbox/sandbox.service.js';
import type { EgressPolicy } from '../sandbox/egress.js';

export interface ChatHistoryMessage {
  role: string;
  content: string;
}

/** Условная стоимость 1000 токенов LLM в рублях. */
export const LLM_COST_PER_1K_TOKENS = 0.01;

/** Минимальная стоимость одного вызова LLM: копейка. */
export const MIN_LLM_BALANCE = 0.01;

/**
 * Стоимость вызова LLM: `LLM_COST_PER_1K_TOKENS` за каждую 1000 токенов.
 * Сумма округляется вверх до копейки, чтобы каждый вызов стоил хотя бы
 * `MIN_LLM_BALANCE`. При нулевом расходе токенов списания нет.
 */
export function calculateLlmCost(
  promptTokens: number,
  completionTokens: number,
): number {
  const total =
    Math.max(0, promptTokens || 0) + Math.max(0, completionTokens || 0);

  if (total === 0) {
    return 0;
  }

  const raw = (total / 1000) * LLM_COST_PER_1K_TOKENS;

  return Math.max(MIN_LLM_BALANCE, Math.ceil(raw * 100) / 100);
}

/** Контекст вызова LLM: чей баланс списывать за токены. */
export interface LlmCallOptions {
  userId?: string;
  /** Агент, от имени которого выполняется вызов (gen_ai.agent.id). */
  agentId?: string;
  /** Навык, инициировавший вызов, если применимо (gen_ai.skill.id). */
  skillId?: string;
  /** Блок «Долговременная память» из pgvector, добавляется в системный промпт. */
  memoryContext?: string;
}

/**
 * Маршрут LLM: одиночный объект (обратная совместимость) или fallback-цепочка
 * из `LlmRouterService.selectRoutes`. Пустая цепочка — env-fallback.
 */
export type LlmRouteInput =
  | LlmRouteSelection
  | readonly LlmRouteSelection[];

/** Транспорт попытки: нативный адаптер или OpenAI-совместимый клиент. */
type LlmExecutor =
  | { kind: 'adapter'; adapter: NativeProviderAdapter }
  | { kind: 'client'; client: ChatOpenAI };

/** Одна попытка цепочки: маршрут (undefined — env-fallback) и транспорт. */
interface LlmAttempt {
  route: LlmRouteSelection | undefined;
  executor: LlmExecutor;
}

/** Состояние стриминговой попытки: отданные дельты и полученный usage. */
interface StreamAttemptState {
  emittedDelta: boolean;
  partialUsage: AIMessage['usage_metadata'];
}

/** Текст ошибки, когда вся fallback-цепочка недоступна. */
export const LLM_ROUTES_UNAVAILABLE_MESSAGE = 'Все LLM-маршруты недоступны';

/** Доля жёсткого лимита, после которой Budget Guard пишет предупреждение. */
export const DAILY_TOKEN_SOFT_LIMIT_RATIO = 0.8;

/**
 * Резерв токенов на ответ модели, который списывается с дневного бюджета
 * ДО вызова провайдера (KI-021). После ответа резерв сверяется с фактическим
 * `usage`: излишек возвращается, недостача дописывается.
 */
export const DEFAULT_RESERVED_OUTPUT_TOKENS = 4096;

/**
 * Размер резерва вывода: `LLM_RESERVE_OUTPUT_TOKENS` из окружения или
 * `DEFAULT_RESERVED_OUTPUT_TOKENS`. Некорректное значение игнорируется,
 * чтобы конфигурация не ломала бюджет.
 */
export function resolveReservedOutputTokens(
  value: string | undefined = process.env.LLM_RESERVE_OUTPUT_TOKENS,
): number {
  const parsed = Number.parseInt(value ?? '', 10);

  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_RESERVED_OUTPUT_TOKENS;
}

/**
 * Резерв дневного бюджета одного вызова LLM: сколько токенов зарезервировано
 * до обращения к провайдеру.
 */
interface TokenReservation {
  readonly reserved: number;
}

/**
 * Начало текущих суток в UTC. Счётчик токенов сбрасывается при первом
 * запросе нового дня; UTC выбран как единая граница для всех реплик API.
 */
export function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

/** Нужно ли сбросить дневной счётчик: счётчик последнего сброса — прошлые сутки. */
export function needsDailyTokenReset(lastReset: Date, now: Date): boolean {
  return lastReset.getTime() < startOfUtcDay(now).getTime();
}

/** Заголовок блока долговременной памяти в системном промпте. */
export const MEMORY_PROMPT_HEADER = '## Долговременная память';

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
  'Вызывает реальный MCP-сервер Ozon Seller. Передайте имя MCP-инструмента в action (например, ozon_get_prices) и аргументы в params';

/** Имя MCP-инструмента Wildberries. */
export const WB_MCP_TOOL_NAME = 'wb_mcp_call';

/** Описание MCP-инструмента Wildberries для LLM. */
export const WB_MCP_TOOL_DESCRIPTION =
  'Вызывает реальный MCP-сервер Wildberries Seller. Передайте имя MCP-инструмента в action (например, wb_cards_list) и аргументы в params';

/**
 * Схема аргументов marketplace MCP-инструментов.
 *
 * Реальная Zod-валидация аргументов выполняется MCP Gateway до отправки на
 * MCP-сервер; здесь та же схема ограничивает вход модели (плоские примитивы,
 * лимиты размеров) и запрещает произвольные вложенные структуры.
 */
export const McpToolSchema = mcpToolCallSchema;

/** Имя mock-инструмента отправки сообщений. */
export const SEND_MESSAGE_TOOL_NAME = 'send_message';

/** Описание mock-инструмента отправки сообщений. */
export const SEND_MESSAGE_TOOL_DESCRIPTION =
  'Отправляет сообщение в Telegram/VK/WhatsApp (заглушка)';

/** Схема аргументов `send_message`. */
export const SendMessageToolSchema = z.object({
  channel: z.string().describe('Канал: telegram, vk или whatsapp'),
  to: z.string().describe('Получатель сообщения'),
  text: z.string().describe('Текст сообщения'),
});

/** Имя mock-инструмента добавления строк в Google Sheets. */
export const GOOGLE_SHEETS_APPEND_TOOL_NAME = 'google_sheets_append';

/** Описание mock-инструмента Google Sheets. */
export const GOOGLE_SHEETS_APPEND_TOOL_DESCRIPTION =
  'Добавляет строки в Google Таблицу (заглушка)';

/** Схема аргументов `google_sheets_append`. */
export const GoogleSheetsAppendToolSchema = z.object({
  sheetId: z.string().describe('Идентификатор таблицы'),
  values: z.array(z.any()).describe('Строки для добавления'),
});

/** Имя mock-инструмента создания Google Docs. */
export const GOOGLE_DOCS_CREATE_TOOL_NAME = 'google_docs_create';

/** Описание mock-инструмента Google Docs. */
export const GOOGLE_DOCS_CREATE_TOOL_DESCRIPTION =
  'Создаёт документ Google Docs (заглушка)';

/** Схема аргументов `google_docs_create`. */
export const GoogleDocsCreateToolSchema = z.object({
  title: z.string().describe('Заголовок документа'),
  content: z.string().describe('Содержимое документа'),
});

/** Имя mock-инструмента генерации изображений. */
export const GENERATE_IMAGE_TOOL_NAME = 'generate_image';

/** Описание mock-инструмента генерации изображений. */
export const GENERATE_IMAGE_TOOL_DESCRIPTION =
  'Генерирует изображение по текстовому промпту (заглушка)';

/** Схема аргументов `generate_image`. */
export const GenerateImageToolSchema = z.object({
  prompt: z.string().describe('Текстовый промпт изображения'),
});

/** Имя mock-инструмента запуска цепочек задач. */
export const RUN_WORKFLOW_TOOL_NAME = 'run_workflow';

/** Описание mock-инструмента запуска цепочек задач. */
export const RUN_WORKFLOW_TOOL_DESCRIPTION =
  'Запускает многошаговую цепочку задач (заглушка)';

/** Схема аргументов `run_workflow`. */
export const RunWorkflowToolSchema = z.object({
  steps: z.array(z.string()).describe('Шаги цепочки задач'),
});

/** Имя инструмента экспорта статьи для Дзен. */
export const PUBLISH_TO_DZEN_TOOL_NAME = 'publish_to_dzen';

/** Описание инструмента экспорта статьи для Дзен. */
export const PUBLISH_TO_DZEN_TOOL_DESCRIPTION =
  'Сохраняет черновик статьи для Дзен в Markdown и возвращает путь к файлу';

/** Схема аргументов `publish_to_dzen`. */
export const PublishToDzenToolSchema = z.object({
  title: z.string().describe('Заголовок статьи'),
  text: z.string().describe('Текст статьи'),
  imageUrl: z.string().optional().describe('URL обложки статьи'),
});

/** Имя mock-инструмента юнит-экономики. */
export const CALCULATE_UNIT_ECONOMICS_TOOL_NAME = 'calculate_unit_economics';

/** Описание mock-инструмента юнит-экономики. */
export const CALCULATE_UNIT_ECONOMICS_TOOL_DESCRIPTION =
  'Считает маржу по SKU (заглушка)';

/** Схема аргументов `calculate_unit_economics`. */
export const CalculateUnitEconomicsToolSchema = z.object({
  sku: z.string().describe('Идентификатор товара'),
});

/** Имя mock-инструмента поиска утечек прибыли. */
export const DETECT_PROFIT_LEAKS_TOOL_NAME = 'detect_profit_leaks';

/** Описание mock-инструмента поиска утечек прибыли. */
export const DETECT_PROFIT_LEAKS_TOOL_DESCRIPTION =
  'Ищет утечки прибыли по продавцу (заглушка)';

/** Схема аргументов `detect_profit_leaks`. */
export const DetectProfitLeaksToolSchema = z.object({
  sellerId: z.string().describe('Идентификатор продавца'),
});

/** Имя mock-инструмента мониторинга цен конкурентов. */
export const MONITOR_COMPETITOR_PRICES_TOOL_NAME = 'monitor_competitor_prices';

/** Описание mock-инструмента мониторинга цен. */
export const MONITOR_COMPETITOR_PRICES_TOOL_DESCRIPTION =
  'Проверяет цены конкурентов по SKU (заглушка)';

/** Схема аргументов `monitor_competitor_prices`. */
export const MonitorCompetitorPricesToolSchema = z.object({
  sku: z.string().describe('Идентификатор товара'),
});

/** Имя mock-инструмента аудита рисков. */
export const AUDIT_FRAUD_RISK_TOOL_NAME = 'audit_fraud_risk';

/** Описание mock-инструмента аудита рисков. */
export const AUDIT_FRAUD_RISK_TOOL_DESCRIPTION =
  'Проверяет доказательный пакет рекламной кампании (заглушка)';

/** Схема аргументов `audit_fraud_risk`. */
export const AuditFraudRiskToolSchema = z.object({
  campaignId: z.string().describe('Идентификатор рекламной кампании'),
});

/** Имя mock-инструмента проверки фактов. */
export const CHECK_FACTS_TOOL_NAME = 'check_facts';

/** Описание mock-инструмента проверки фактов. */
export const CHECK_FACTS_TOOL_DESCRIPTION =
  'Проверяет факты в тексте (заглушка)';

/** Схема аргументов `check_facts`. */
export const CheckFactsToolSchema = z.object({
  text: z.string().describe('Текст для проверки'),
});

/** Имя mock-инструмента скрининга резюме. */
export const SCREEN_RESUME_TOOL_NAME = 'screen_resume';

/** Описание mock-инструмента скрининга резюме. */
export const SCREEN_RESUME_TOOL_DESCRIPTION =
  'Оценивает резюме кандидата (заглушка)';

/** Схема аргументов `screen_resume`. */
export const ScreenResumeToolSchema = z.object({
  resumeText: z.string().describe('Текст резюме'),
});

/** Имя mock-инструмента извлечения данных из документа. */
export const EXTRACT_DOCUMENT_DATA_TOOL_NAME = 'extract_document_data';

/** Описание mock-инструмента извлечения данных из документа. */
export const EXTRACT_DOCUMENT_DATA_TOOL_DESCRIPTION =
  'Извлекает сумму и дату из договора (заглушка)';

/** Схема аргументов `extract_document_data`. */
export const ExtractDocumentDataToolSchema = z.object({
  documentText: z.string().describe('Текст документа'),
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
  /**
   * Egress-политика навыка, объявившего инструмент: FQDN-allowlist из
   * манифеста. Отсутствие политики означает полный запрет сети
   * (deny by default, ADR 0004 п.3).
   */
  egress?: EgressPolicy;
}

/** Опции MCP-инструмента; client позволяет подменить транспорт в тестах. */
export interface McpToolOptions extends SandboxToolOptions {
  client?: Pick<McpClient, 'callTool'>;
  /**
   * `mcp_endpoint` из манифеста навыка-коннектора. Это основной источник
   * адреса MCP-сервера; env-переменная используется только как fallback для
   * обратной совместимости.
   */
  endpoint?: string;
  /** Bearer-токен MCP-сервера; по умолчанию `MCP_AUTH_TOKEN` из env. */
  authToken?: string;
}

/**
 * Адрес MCP-сервера: `mcp_endpoint` из манифеста навыка в приоритете,
 * env-переменная — только fallback. Адреса в коде не хардкодятся.
 */
export function resolveMcpEndpoint(
  platform: McpProvider,
  manifestEndpoint?: string,
): string | null {
  const fromManifest = manifestEndpoint?.trim() ?? '';

  if (fromManifest !== '') {
    return fromManifest;
  }

  const fromEnv =
    platform === 'ozon' ? process.env.OZON_MCP_URL : process.env.WB_MCP_URL;

  return fromEnv === undefined || fromEnv.trim() === '' ? null : fromEnv.trim();
}

export interface DzenPublishOptions extends SandboxToolOptions {
  /** Каталог для готовых Markdown-черновиков (по умолчанию `./dzen-output`). */
  outputDir?: string;
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
  private readonly mcpClients = new Map<string, McpClient>();
  /**
   * Gateway кешируется на инстанс клиента: discovery `tools/list` ленивый и
   * one-time на gateway, поэтому при создании нового gateway на каждый вызов
   * каждый MCP tool-call делал бы лишний `tools/list`.
   */
  private readonly mcpGateways = new WeakMap<McpClient, McpGateway>();

  constructor(
    private readonly sandboxService: SandboxService,
    @Optional() private readonly promptsService?: PromptsService,
    @Optional() private readonly billingService?: BillingService,
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly metricsService?: MetricsService,
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

        return this.sandboxService.runCommand(code, sandboxEnv(), {
          egress: options.egress,
        });
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

        return this.sandboxService.runCommand(
          TAVILY_SEARCH_COMMAND,
          {
            TAVILY_REQUEST_BODY: requestBody,
          },
          { egress: options.egress },
        );
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

        return this.sandboxService.runCommand(command, sandboxEnv(), {
          // Сеть включается только явным egress-allowlist навыка; для
          // локальных команд разрешено выполняться без сети.
          egress: options.egress,
        });
      },
    });
  }

  /** Реальный MCP-инструмент Ozon Seller. */
  createOzonMcpTool(options: McpToolOptions = {}): DynamicStructuredTool {
    return this.createMarketplaceMcpTool('ozon', options);
  }

  /** Реальный MCP-инструмент Wildberries Seller. */
  createWbMcpTool(options: McpToolOptions = {}): DynamicStructuredTool {
    return this.createMarketplaceMcpTool('wb', options);
  }

  private createMarketplaceMcpTool(
    platform: McpProvider,
    options: McpToolOptions,
  ): DynamicStructuredTool {
    const config =
      platform === 'ozon'
        ? {
            name: OZON_MCP_TOOL_NAME,
            description: OZON_MCP_TOOL_DESCRIPTION,
            keyVars: ['OZON_CLIENT_ID', 'OZON_API_KEY'],
            missingKeys: 'Ozon API keys not configured',
          }
        : {
            name: WB_MCP_TOOL_NAME,
            description: WB_MCP_TOOL_DESCRIPTION,
            keyVars: ['WB_API_TOKEN'],
            missingKeys: 'WB API token not configured',
          };

    return new DynamicStructuredTool({
      name: config.name,
      description: config.description,
      schema: McpToolSchema,
      func: async ({ action, params }) => {
        // Ключи проверяем только для реального клиента: в тестах транспорт
        // подменяется через `options.client`.
        if (
          options.client === undefined &&
          !hasEnv(...config.keyVars)
        ) {
          return config.missingKeys;
        }

        const gateway = this.getMcpGateway(platform, options);

        if (gateway === null) {
          // Единый JSON-формат: ошибка конфигурации MCP-сервера (503).
          throw mcpUnavailableError();
        }

        await options.beforeExecute?.();

        // Ошибки провайдера/таймауты — ApiException с единым телом ошибки;
        // не превращаем их в текст для модели, чтобы клиент получил код.
        return gateway.call({ action, params });
      },
    });
  }

  /** Gateway одного провайдера: валидация аргументов + вызов транспорта. */
  private getMcpGateway(
    platform: McpProvider,
    options: McpToolOptions,
  ): McpGateway | null {
    if (options.client !== undefined) {
      // Подменённый транспорт (тесты): listTools недоступен → structural-only.
      return new McpGateway({ provider: platform, client: options.client });
    }

    const client = this.getMcpClient(platform, options.endpoint, options.authToken);

    if (client === null) {
      return null;
    }

    const cached = this.mcpGateways.get(client);

    if (cached !== undefined) {
      return cached;
    }

    const gateway = new McpGateway({
      provider: platform,
      client,
      // Arrow: при вызове сохраняется this McpClient.
      listTools: () => client.listTools(),
    });

    this.mcpGateways.set(client, gateway);

    return gateway;
  }

  private getMcpClient(
    platform: McpProvider,
    manifestEndpoint?: string,
    authToken?: string,
  ): McpClient | null {
    const url = resolveMcpEndpoint(platform, manifestEndpoint);

    if (url === null) {
      return null;
    }

    const cached = this.mcpClients.get(url);

    if (cached !== undefined) {
      return cached;
    }

    const token = authToken ?? process.env.MCP_AUTH_TOKEN;

    const client = new McpClient({
      baseUrl: url,
      ...(token === undefined || token === '' ? {} : { authToken: token }),
    });

    this.mcpClients.set(url, client);

    return client;
  }

  /** Mock-инструмент отправки сообщений в мессенджеры. */
  createSendMessageTool(
    options: SandboxToolOptions = {},
  ): DynamicStructuredTool {
    return new DynamicStructuredTool({
      name: SEND_MESSAGE_TOOL_NAME,
      description: SEND_MESSAGE_TOOL_DESCRIPTION,
      schema: SendMessageToolSchema,
      func: async ({ channel, to }) => {
        await options.beforeExecute?.();

        return `Сообщение отправлено в ${channel} для ${to}`;
      },
    });
  }

  /** Mock-инструмент добавления строк в Google Sheets. */
  createGoogleSheetsAppendTool(
    options: SandboxToolOptions = {},
  ): DynamicStructuredTool {
    return new DynamicStructuredTool({
      name: GOOGLE_SHEETS_APPEND_TOOL_NAME,
      description: GOOGLE_SHEETS_APPEND_TOOL_DESCRIPTION,
      schema: GoogleSheetsAppendToolSchema,
      func: async ({ sheetId }) => {
        await options.beforeExecute?.();

        return `Данные добавлены в таблицу ${sheetId}`;
      },
    });
  }

  /** Mock-инструмент создания Google Docs. */
  createGoogleDocsCreateTool(
    options: SandboxToolOptions = {},
  ): DynamicStructuredTool {
    return new DynamicStructuredTool({
      name: GOOGLE_DOCS_CREATE_TOOL_NAME,
      description: GOOGLE_DOCS_CREATE_TOOL_DESCRIPTION,
      schema: GoogleDocsCreateToolSchema,
      func: async ({ title }) => {
        await options.beforeExecute?.();

        return `Документ "${title}" создан`;
      },
    });
  }

  /** Mock-инструмент генерации изображений. */
  createGenerateImageTool(
    options: SandboxToolOptions = {},
  ): DynamicStructuredTool {
    return new DynamicStructuredTool({
      name: GENERATE_IMAGE_TOOL_NAME,
      description: GENERATE_IMAGE_TOOL_DESCRIPTION,
      schema: GenerateImageToolSchema,
      func: async () => {
        await options.beforeExecute?.();

        return 'https://placehold.co/600x400?text=Generated';
      },
    });
  }

  /** Mock-инструмент запуска многошаговых цепочек. */
  createRunWorkflowTool(
    options: SandboxToolOptions = {},
  ): DynamicStructuredTool {
    return new DynamicStructuredTool({
      name: RUN_WORKFLOW_TOOL_NAME,
      description: RUN_WORKFLOW_TOOL_DESCRIPTION,
      schema: RunWorkflowToolSchema,
      func: async ({ steps }) => {
        await options.beforeExecute?.();

        return `Цепочка задач выполнена: ${steps.join(' -> ')}`;
      },
    });
  }

  /**
   * Экспортирует черновик статьи для Дзен в Markdown. Файл создаётся в
   * песочнице (`/tmp/dzen-output`) и переносится на хост через stdout,
   * потому что rootfs контейнера доступен только для чтения.
   */
  createPublishToDzenTool(
    options: DzenPublishOptions = {},
  ): DynamicStructuredTool {
    return new DynamicStructuredTool({
      name: PUBLISH_TO_DZEN_TOOL_NAME,
      description: PUBLISH_TO_DZEN_TOOL_DESCRIPTION,
      schema: PublishToDzenToolSchema,
      func: async ({ title, text, imageUrl }) => {
        await options.beforeExecute?.();

        const filename = `dzen-${randomUUID()}.md`;
        const markdownParts = [`# ${title}`, ''];

        if (imageUrl !== undefined && imageUrl !== '') {
          markdownParts.push(`![Обложка](${imageUrl})`, '');
        }

        markdownParts.push(text, '');

        const markdown = markdownParts.join('\n');
        const encoded = Buffer.from(markdown, 'utf8').toString('base64');
        const script = [
          'set -eu',
          'mkdir -p /tmp/dzen-output',
          `python3 -c 'import base64,os,pathlib; p=pathlib.Path("/tmp/dzen-output")/os.environ["DZEN_FILENAME"]; p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(base64.b64decode(os.environ["DZEN_CONTENT_B64"])); print(base64.b64encode(p.read_bytes()).decode())'`,
        ].join('\n');
        const output = await this.sandboxService.runCommand(script, {
          DZEN_FILENAME: filename,
          DZEN_CONTENT_B64: encoded,
        });
        const encodedResult = output.trim();

        if (encodedResult === '') {
          throw new Error('Песочница не вернула содержимое статьи');
        }

        const decoded = Buffer.from(encodedResult, 'base64').toString('utf8');
        const outputDir = options.outputDir ?? './dzen-output';
        await mkdir(outputDir, { recursive: true });
        const hostPath = join(outputDir, filename);
        await writeFile(hostPath, decoded, 'utf8');

        return `Черновик статьи «${title}» сохранён: ${hostPath}`;
      },
    });
  }

  /** Mock-инструмент расчёта юнит-экономики. */
  createCalculateUnitEconomicsTool(
    options: SandboxToolOptions = {},
  ): DynamicStructuredTool {
    return new DynamicStructuredTool({
      name: CALCULATE_UNIT_ECONOMICS_TOOL_NAME,
      description: CALCULATE_UNIT_ECONOMICS_TOOL_DESCRIPTION,
      schema: CalculateUnitEconomicsToolSchema,
      func: async ({ sku }) => {
        await options.beforeExecute?.();

        return `Маржа для ${sku} составляет 25%.`;
      },
    });
  }

  /** Mock-инструмент поиска утечек прибыли. */
  createDetectProfitLeaksTool(
    options: SandboxToolOptions = {},
  ): DynamicStructuredTool {
    return new DynamicStructuredTool({
      name: DETECT_PROFIT_LEAKS_TOOL_NAME,
      description: DETECT_PROFIT_LEAKS_TOOL_DESCRIPTION,
      schema: DetectProfitLeaksToolSchema,
      func: async () => {
        await options.beforeExecute?.();

        return 'Найдена утечка на 120 000 ₽ из-за штрафа за габариты.';
      },
    });
  }

  /** Mock-инструмент мониторинга цен конкурентов. */
  createMonitorCompetitorPricesTool(
    options: SandboxToolOptions = {},
  ): DynamicStructuredTool {
    return new DynamicStructuredTool({
      name: MONITOR_COMPETITOR_PRICES_TOOL_NAME,
      description: MONITOR_COMPETITOR_PRICES_TOOL_DESCRIPTION,
      schema: MonitorCompetitorPricesToolSchema,
      func: async ({ sku }) => {
        await options.beforeExecute?.();

        return `Конкурент снизил цену на ${sku} до 990 ₽.`;
      },
    });
  }

  /** Mock-инструмент аудита рисков санкций. */
  createAuditFraudRiskTool(
    options: SandboxToolOptions = {},
  ): DynamicStructuredTool {
    return new DynamicStructuredTool({
      name: AUDIT_FRAUD_RISK_TOOL_NAME,
      description: AUDIT_FRAUD_RISK_TOOL_DESCRIPTION,
      schema: AuditFraudRiskToolSchema,
      func: async () => {
        await options.beforeExecute?.();

        return 'Доказательный пакет неполный. Риск санкции высокий.';
      },
    });
  }

  /** Mock-инструмент проверки фактов. */
  createCheckFactsTool(
    options: SandboxToolOptions = {},
  ): DynamicStructuredTool {
    return new DynamicStructuredTool({
      name: CHECK_FACTS_TOOL_NAME,
      description: CHECK_FACTS_TOOL_DESCRIPTION,
      schema: CheckFactsToolSchema,
      func: async () => {
        await options.beforeExecute?.();

        return 'Факты подтверждены (0 ошибок).';
      },
    });
  }

  /** Mock-инструмент скрининга резюме. */
  createScreenResumeTool(
    options: SandboxToolOptions = {},
  ): DynamicStructuredTool {
    return new DynamicStructuredTool({
      name: SCREEN_RESUME_TOOL_NAME,
      description: SCREEN_RESUME_TOOL_DESCRIPTION,
      schema: ScreenResumeToolSchema,
      func: async () => {
        await options.beforeExecute?.();

        return 'Кандидат подходит (Score: 85/100).';
      },
    });
  }

  /** Mock-инструмент извлечения данных из договора. */
  createExtractDocumentDataTool(
    options: SandboxToolOptions = {},
  ): DynamicStructuredTool {
    return new DynamicStructuredTool({
      name: EXTRACT_DOCUMENT_DATA_TOOL_NAME,
      description: EXTRACT_DOCUMENT_DATA_TOOL_DESCRIPTION,
      schema: ExtractDocumentDataToolSchema,
      func: async () => {
        await options.beforeExecute?.();

        return '{"amount": "100000", "date": "2026-11-13"}';
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
   *
   * `route` — одиночный маршрут (обратная совместимость) или fallback-цепочка
   * из `LlmRouterService.selectRoutes`. На retriable-ошибку провайдера
   * (429, >=500, таймаут, обрыв соединения) запрос повторяется на следующем
   * маршруте; 400/401/403 пробрасываются без переключения (KI-010).
   *
   * Дневной бюджет резервируется один раз ДО первой попытки (KI-021): если
   * резерв не помещается в лимит, клиент получает 429, а токены провайдера
   * не тратятся. Резерв возвращается или сверяется ровно один раз.
   */
  async chatWithTools(
    messages: BaseMessage[],
    tools: StructuredToolInterface[],
    route?: LlmRouteInput,
    options: LlmCallOptions = {},
  ): Promise<AIMessage> {
    const routes = normalizeRouteChain(route);
    const attempts = this.buildAttempts(routes);

    // Ни одного доступного транспорта (LLM не настроен) — эхо-заглушка.
    if (attempts.length === 0) {
      return this.echoMessage(messages);
    }

    await this.assertCanAffordLlm(options.userId);

    const systemPrompt = await this.getSystemPrompt(options.memoryContext);
    const reservation = await this.reserveDailyTokens(
      options.userId,
      estimateMessagesTokens(messages, systemPrompt),
    );
    const taskType = routes[0]?.taskType ?? 'chat';
    let lastError: unknown;

    for (let index = 0; index < attempts.length; index++) {
      const attempt = attempts[index]!;

      try {
        const response = await this.invokeAttempt(
          attempt,
          messages,
          tools,
          systemPrompt,
        );

        await this.recordLlmResponse(
          attempt.route,
          options,
          messages,
          systemPrompt,
          reservation,
          response,
        );

        return response;
      } catch (error) {
        lastError = error;

        const next = attempts[index + 1];

        if (next === undefined || !isRetriableLlmError(error)) {
          break;
        }

        this.logRouterFallback(attempt.route, next.route, error, taskType);
      }
    }

    // Ни одна попытка не дала ответа: возвращаем резерв один раз.
    await this.refundDailyTokens(options.userId, reservation);

    // 502 отдаём только когда реально была fallback-цепочка: одиночный
    // маршрут и env-fallback сохраняют прежнее поведение с исходной ошибкой.
    if (routes.length > 1 && isRetriableLlmError(lastError)) {
      throw llmUnavailableError();
    }

    throw lastError;
  }

  /**
   * Стриминговый вариант `chatWithTools`: отдаёт текст по мере генерации.
   * Последним элементом итератора приходит собранное сообщение модели —
   * по нему граф решает, нужно ли запускать инструменты.
   *
   * Fallback по цепочке маршрутов возможен только ДО первой отданной дельты:
   * после неё повтор запроса показал бы пользователю текст дважды. Резерв
   * дневного бюджета берётся один раз до первой попытки, возвращается или
   * сверяется тоже один раз.
   */
  async *chatWithToolsStream(
    messages: BaseMessage[],
    tools: StructuredToolInterface[],
    route?: LlmRouteInput,
    options: LlmCallOptions = {},
  ): AsyncGenerator<ChatStreamChunk, void, unknown> {
    const routes = normalizeRouteChain(route);
    const attempts = this.buildAttempts(routes);

    // Ни одного доступного транспорта (LLM не настроен) — эхо-заглушка.
    if (attempts.length === 0) {
      const text = this.echoText(messages);

      yield { type: 'delta', text };
      yield { type: 'message', message: new AIMessage(text) };
      return;
    }

    await this.assertCanAffordLlm(options.userId);

    const systemPrompt = await this.getSystemPrompt(options.memoryContext);
    // Резерв до первой попытки и, значит, до первой `delta`.
    const reservation = await this.reserveDailyTokens(
      options.userId,
      estimateMessagesTokens(messages, systemPrompt),
    );
    const taskType = routes[0]?.taskType ?? 'chat';

    for (let index = 0; index < attempts.length; index++) {
      const attempt = attempts[index]!;
      const state: StreamAttemptState = {
        emittedDelta: false,
        partialUsage: undefined,
      };
      let message: AIMessage;

      try {
        message = yield* this.streamAttempt(
          attempt,
          messages,
          tools,
          systemPrompt,
          state,
        );
      } catch (error) {
        if (totalTokens(state.partialUsage) > 0) {
          // Usage успел прийти до сбоя: сверяем резерв с фактическим
          // расходом один раз; повтор на другом маршруте не нужен.
          await this.reconcileDailyTokens(
            options.userId,
            reservation,
            state.partialUsage,
          );
          throw error;
        }

        if (state.emittedDelta) {
          // Часть ответа уже ушла клиенту: повторять запрос нельзя.
          await this.refundDailyTokens(options.userId, reservation);
          throw error;
        }

        const next = attempts[index + 1];

        if (next === undefined || !isRetriableLlmError(error)) {
          await this.refundDailyTokens(options.userId, reservation);

          if (routes.length > 1 && isRetriableLlmError(error)) {
            throw llmUnavailableError();
          }

          throw error;
        }

        this.logRouterFallback(attempt.route, next.route, error, taskType);
        continue;
      }

      await this.recordLlmResponse(
        attempt.route,
        options,
        messages,
        systemPrompt,
        reservation,
        message,
      );

      if (
        !state.emittedDelta &&
        typeof message.content === 'string' &&
        message.content !== ''
      ) {
        yield { type: 'delta', text: message.content };
      }

      yield { type: 'message', message };
      return;
    }

    // Цепочка исчерпана без ответа (сюда не доходим при штатной работе):
    // возвращаем резерв один раз и отдаём единый код недоступности.
    await this.refundDailyTokens(options.userId, reservation);
    throw llmUnavailableError();
  }

  /**
   * Проверяет, что на балансе хватает денег на минимальный вызов LLM.
   * Вызывается до обращения к модели: без этого пользователь с нулевым
   * балансом мог бы жечь токены бесплатно.
   */
  private async assertCanAffordLlm(userId?: string): Promise<void> {
    if (!userId || !this.billingService) {
      return;
    }

    const { balance } = await this.billingService.getBalance(userId);

    if (Number.parseFloat(balance) < MIN_LLM_BALANCE) {
      throw new BadRequestException(ERROR_KEYS.insufficientFunds);
    }
  }

  /**
   * Budget Guard: атомарный резерв дневного бюджета ДО вызова провайдера.
   *
   * Порядок (KI-021):
   * 1. ленивый сброс суток условным `updateMany` — как раньше, чтобы не
   *    сбрасывать счётчик дважды при параллельных запросах;
   * 2. атомарный резерв `prompt estimate + reserved output` тем же приёмом:
   *    `where dailyTokensUsed <= dailyTokenLimit - reserved` и `increment`.
   *    Postgres блокирует строку, поэтому конкурентные запросы делят лимит
   *    без гонок;
   * 3. `count === 0` — резерв не помещается: пишем `gen_ai.budget.hard_limit`
   *    и отдаём 429 до обращения к провайдеру (токены не тратятся);
   * 4. после успешного резерва, если счётчик достиг 80% лимита, пишем
   *    `gen_ai.budget.soft_limit` (предупреждение, не отказ).
   *
   * Возвращает `null`, если учёт не ведётся (нет пользователя или Prisma).
   */
  private async reserveDailyTokens(
    userId: string | undefined,
    estimatedPromptTokens: number,
  ): Promise<TokenReservation | null> {
    if (!userId || !this.prisma) {
      return null;
    }

    const reserved = estimatedPromptTokens + resolveReservedOutputTokens();

    const now = new Date();
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        dailyTokenLimit: true,
        dailyTokensUsed: true,
        lastTokenReset: true,
      },
    });

    if (!user) {
      return null;
    }

    if (needsDailyTokenReset(user.lastTokenReset, now)) {
      // Условный updateMany исключает двойной сброс при параллельных запросах.
      await this.prisma.user.updateMany({
        where: { id: userId, lastTokenReset: { lt: startOfUtcDay(now) } },
        data: { dailyTokensUsed: 0, lastTokenReset: now },
      });
    }

    const reservation = await this.prisma.user.updateMany({
      where: {
        id: userId,
        dailyTokensUsed: { lte: user.dailyTokenLimit - reserved },
      },
      data: { dailyTokensUsed: { increment: reserved } },
    });

    if (reservation.count === 0) {
      this.logger.warn(
        JSON.stringify({
          event: 'gen_ai.budget.hard_limit',
          userId,
          'gen_ai.tokens': reserved,
          'gen_ai.daily_token_limit': user.dailyTokenLimit,
        }),
      );

      throw new DailyTokenLimitException();
    }

    // Читаем счётчик после резерва: параллельные вызовы могли увеличить его
    // сильнее, чем видно в снапшоте `user`.
    const current = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { dailyTokensUsed: true },
    });
    const used = current?.dailyTokensUsed ?? user.dailyTokensUsed + reserved;
    const softLimit = Math.floor(
      user.dailyTokenLimit * DAILY_TOKEN_SOFT_LIMIT_RATIO,
    );

    if (used >= softLimit) {
      this.logger.warn(
        JSON.stringify({
          event: 'gen_ai.budget.soft_limit',
          userId,
          'gen_ai.daily_tokens_used': used,
          'gen_ai.daily_token_limit': user.dailyTokenLimit,
          'gen_ai.daily_token_soft_limit': softLimit,
        }),
      );
    }

    return { reserved };
  }

  /**
   * Сверяет резерв с фактическим расходом после ответа провайдера.
   *
   * `delta = actual - reserved`: излишек возвращается в бюджет атомарным
   * `decrement` с защитой от отрицательного счётчика, недостача дописывается
   * атомарным `increment` с условием жёсткого лимита. Если дописать некуда,
   * пишем `gen_ai.budget.reconcile_overflow` и прижимаем счётчик к лимиту:
   * жёсткий лимит не превышается, но фактический расход по этой операции
   * может быть больше учтённого (осознанный drift, KI-021).
   */
  private async reconcileDailyTokens(
    userId: string | undefined,
    reservation: TokenReservation | null,
    usage: AIMessage['usage_metadata'],
  ): Promise<void> {
    if (!userId || !this.prisma || reservation === null) {
      return;
    }

    const actual = totalTokens(usage);
    const delta = actual - reservation.reserved;

    if (delta === 0) {
      return;
    }

    if (delta < 0) {
      const refund = -delta;

      await this.prisma.user.updateMany({
        where: { id: userId, dailyTokensUsed: { gte: refund } },
        data: { dailyTokensUsed: { decrement: refund } },
      });

      return;
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { dailyTokenLimit: true },
    });

    if (!user) {
      return;
    }

    const added = await this.prisma.user.updateMany({
      where: {
        id: userId,
        dailyTokensUsed: { lte: user.dailyTokenLimit - delta },
      },
      data: { dailyTokensUsed: { increment: delta } },
    });

    if (added.count !== 0) {
      return;
    }

    this.logger.warn(
      JSON.stringify({
        event: 'gen_ai.budget.reconcile_overflow',
        userId,
        'gen_ai.tokens': delta,
        'gen_ai.daily_token_limit': user.dailyTokenLimit,
      }),
    );

    await this.prisma.user.updateMany({
      where: { id: userId },
      data: { dailyTokensUsed: user.dailyTokenLimit },
    });
  }

  /**
   * Возвращает резерв в бюджет, если провайдер не вернул ответ (ошибка до
   * получения `usage`). Условие `dailyTokensUsed >= refund` защищает счётчик
   * от отрицательного значения, если сутки уже сбросились.
   */
  private async refundDailyTokens(
    userId: string | undefined,
    reservation: TokenReservation | null,
  ): Promise<void> {
    if (!userId || !this.prisma || reservation === null) {
      return;
    }

    await this.prisma.user.updateMany({
      where: { id: userId, dailyTokensUsed: { gte: reservation.reserved } },
      data: { dailyTokensUsed: { decrement: reservation.reserved } },
    });
  }

  /**
   * Учёт полученного ответа: `usage` с fallback-оценкой (KI-022), лог
   * `gen_ai.usage`, списание денег и сверка дневного резерва. Общий
   * хвост всех четырёх путей вызова LLM.
   */
  private async recordLlmResponse(
    route: LlmRouteSelection | undefined,
    options: LlmCallOptions,
    messages: BaseMessage[],
    systemPrompt: string,
    reservation: TokenReservation | null,
    message: AIMessage,
  ): Promise<void> {
    const { usage, estimated } = this.resolveUsage(
      route,
      messages,
      systemPrompt,
      messageContentToText(message.content),
      message.usage_metadata,
    );

    const promptTokens = usage?.input_tokens ?? 0;
    const completionTokens = usage?.output_tokens ?? 0;
    const cost = calculateLlmCost(promptTokens, completionTokens);
    const model = this.metricsModel(route);
    const agentId = options.agentId?.trim() || 'unknown';

    this.logGenAiUsage(route, usage, estimated, options, cost);
    this.metricsService?.countLlmCost(
      options.userId ?? 'anonymous',
      model,
      agentId,
      cost,
    );
    recordGenAiUsageSpan({
      system: this.metricsProvider(route),
      model,
      tenantId: options.userId ?? 'anonymous',
      agentId,
      skillId: options.skillId,
      promptTokens,
      completionTokens,
      cost,
      estimated,
    });

    await this.chargeLlmUsage(options.userId, usage, route);
    await this.reconcileDailyTokens(options.userId, reservation, usage);
  }

  /**
   * `usage` ответа или fallback-оценка, если провайдер не прислал usage
   * (KI-022: GigaChat может опустить его в стрим-чанке). Оценка считается
   * локальным токенизатором по отправленному prompt и тексту ответа; при
   * наличии `usage` поведение не меняется.
   */
  private resolveUsage(
    route: LlmRouteSelection | undefined,
    messages: BaseMessage[],
    systemPrompt: string,
    completionText: string,
    usage: AIMessage['usage_metadata'],
  ): { usage: AIMessage['usage_metadata']; estimated: boolean } {
    if (totalTokens(usage) > 0) {
      return { usage, estimated: false };
    }

    return {
      usage: estimateUsageFromMessages(messages, completionText, systemPrompt),
      estimated: true,
    };
  }

  /**
   * Списывает стоимость токенов с баланса пользователя. Ошибку списания
   * только логируем: ответ модели уже получен, и ронять запрос из-за
   * биллинга хуже, чем недополучить копейку.
   *
   * `route` попадает в `LedgerEntry.llmRouteName`: по этой колонке дневной
   * бюджет маршрута считается в `LlmRouterService.selectRoutes` (KI-010).
   */
  private async chargeLlmUsage(
    userId: string | undefined,
    usage: AIMessage['usage_metadata'],
    route?: LlmRouteSelection,
  ): Promise<void> {
    if (!userId || !this.billingService) {
      return;
    }

    const cost = calculateLlmCost(
      usage?.input_tokens ?? 0,
      usage?.output_tokens ?? 0,
    );

    if (cost === 0) {
      return;
    }

    // Пятый аргумент передаём только для маршрута: вызовы без маршрута
    // сохраняют прежнюю сигнатуру (env-fallback, обратная совместимость).
    const args: Parameters<BillingService['chargeForSkill']> = [
      userId,
      cost,
      'Использование LLM',
      randomUUID(),
    ];

    if (route !== undefined) {
      args.push(route.name);
    }

    try {
      await this.billingService.chargeForSkill(...args);
    } catch (error) {
      this.logger.warn(
        `Не удалось списать ${cost} ₽ за LLM у ${userId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Вызов модели с учётом ошибок в `llm_errors_total`. Ошибку пробрасываем
   * дальше: метрика не должна менять поведение обработки сбоев.
   */
  private async trackedLlmCall<T>(
    route: LlmRouteSelection | undefined,
    call: () => Promise<T>,
  ): Promise<T> {
    try {
      return await call();
    } catch (error) {
      this.recordLlmError(route, error);
      throw error;
    }
  }

  private recordLlmError(
    route: LlmRouteSelection | undefined,
    error: unknown,
  ): void {
    this.metricsService?.countLlmError(
      this.metricsProvider(route),
      this.metricsModel(route),
      error instanceof Error ? error.name : 'UnknownError',
    );
  }

  private metricsProvider(route?: LlmRouteSelection): string {
    return route?.providerType || 'openai';
  }

  private metricsModel(route?: LlmRouteSelection): string {
    return route?.modelName?.trim() || process.env.LLM_MODEL || 'unknown';
  }

  /**
   * OTel-совместимый лог вызова LLM. Пока пишем JSON в лог приложения:
   * позже эти атрибуты можно отправить в OTLP-коллектор без изменения
   * вызывающего кода. Для fallback-оценки (провайдер не прислал usage)
   * добавляется флаг `gen_ai.usage_estimated` и отдельное событие
   * `gen_ai.usage.fallback`, чтобы такие вызовы было видно в метриках.
   */
  private logGenAiUsage(
    route: LlmRouteSelection | undefined,
    usage: AIMessage['usage_metadata'],
    estimated = false,
    options: LlmCallOptions = {},
    cost = 0,
  ): void {
    const promptTokens = usage?.input_tokens ?? 0;
    const completionTokens = usage?.output_tokens ?? 0;
    const agentId = options.agentId?.trim() || 'unknown';
    const tenantId = options.userId ?? 'anonymous';
    const model = this.metricsModel(route);

    this.metricsService?.countLlmTokens(
      this.metricsProvider(route),
      this.metricsModel(route),
      promptTokens,
      completionTokens,
    );

    this.logger.log(
      JSON.stringify({
        event: 'gen_ai.usage',
        'gen_ai.system': this.metricsProvider(route),
        'gen_ai.model': model,
        'gen_ai.route': route?.name ?? 'env',
        'gen_ai.agent.id': agentId,
        'gen_ai.tenant.id': tenantId,
        'gen_ai.skill.id': options.skillId ?? 'unknown',
        'gen_ai.usage.cost': cost,
        'gen_ai.prompt_tokens': promptTokens,
        'gen_ai.completion_tokens': completionTokens,
        ...(estimated ? { 'gen_ai.usage_estimated': true } : {}),
      }),
    );

    if (estimated) {
      this.logger.warn(
        JSON.stringify({
          event: 'gen_ai.usage.fallback',
          'gen_ai.system': this.metricsProvider(route),
          'gen_ai.model': model,
          'gen_ai.agent.id': agentId,
          'gen_ai.tenant.id': tenantId,
        }),
      );
    }
  }

  /**
   * Разрешает транспорт для каждой попытки цепочки. Пустая цепочка — одна
   * попытка на env-клиенте (`this.client`). Маршруты без пригодной
   * конфигурации пропускаются с событием fallback.
   */
  private buildAttempts(routes: LlmRouteSelection[]): LlmAttempt[] {
    if (routes.length === 0) {
      const executor = this.resolveExecutor(undefined);

      return executor === null ? [] : [{ route: undefined, executor }];
    }

    const attempts: LlmAttempt[] = [];

    for (let index = 0; index < routes.length; index++) {
      const route = routes[index]!;
      const executor = this.resolveExecutor(route);

      if (executor === null) {
        this.logRouterFallback(
          route,
          routes[index + 1],
          new Error('маршрут не сконфигурирован'),
          route.taskType ?? 'chat',
        );
        continue;
      }

      attempts.push({ route, executor });
    }

    return attempts;
  }

  /** Маршрут попытки → нативный адаптер или OpenAI-совместимый клиент. */
  private resolveExecutor(route?: LlmRouteSelection): LlmExecutor | null {
    const adapter = this.resolveAdapter(route);

    if (adapter !== null) {
      return { kind: 'adapter', adapter };
    }

    const client = this.resolveClient(route);

    return client === null ? null : { kind: 'client', client };
  }

  /** Нестримовая попытка: ответ модели или ошибка провайдера. */
  private async invokeAttempt(
    attempt: LlmAttempt,
    messages: BaseMessage[],
    tools: StructuredToolInterface[],
    systemPrompt: string,
  ): Promise<AIMessage> {
    const { executor } = attempt;

    if (executor.kind === 'adapter') {
      return this.trackedLlmCall(attempt.route, () =>
        executor.adapter.chat({ messages, tools, systemPrompt }),
      );
    }

    const model =
      tools.length > 0 ? executor.client.bindTools(tools) : executor.client;

    return this.trackedLlmCall(attempt.route, () =>
      model.invoke(withLanguageInstruction(messages, systemPrompt)),
    );
  }

  /** Одна стриминговая попытка: адаптер с fallback на его `chat` или клиент. */
  private async *streamAttempt(
    attempt: LlmAttempt,
    messages: BaseMessage[],
    tools: StructuredToolInterface[],
    systemPrompt: string,
    state: StreamAttemptState,
  ): AsyncGenerator<ChatStreamChunk, AIMessage, unknown> {
    const { executor } = attempt;

    if (executor.kind === 'adapter') {
      return yield* this.streamAdapterAttempt(
        executor.adapter,
        attempt.route,
        { messages, tools, systemPrompt },
        state,
      );
    }

    return yield* this.streamClientAttempt(
      executor.client,
      attempt.route,
      messages,
      tools,
      systemPrompt,
      state,
    );
  }

  /**
   * Стриминг нативного провайдера. Если стрима нет или он упал до первой
   * дельты — тот же адаптер отвечает целиком (`chat`); после дельты ошибка
   * пробрасывается, повторять запрос нельзя.
   */
  private async *streamAdapterAttempt(
    adapter: NativeProviderAdapter,
    route: LlmRouteSelection | undefined,
    request: NativeChatRequest,
    state: StreamAttemptState,
  ): AsyncGenerator<ChatStreamChunk, AIMessage, unknown> {
    if (adapter.chatStream === undefined) {
      // Адаптеры без стриминга (например, YandexGPT) отвечают целиком.
      return await this.trackedLlmCall(route, () => adapter.chat(request));
    }

    try {
      const stream = adapter.chatStream(request);
      let step = await stream.next();

      while (!step.done) {
        if (step.value.type === 'delta' && step.value.text !== '') {
          state.emittedDelta = true;
          yield { type: 'delta', text: step.value.text };
        }

        step = await stream.next();
      }

      return step.value;
    } catch (error) {
      this.recordLlmError(route, error);

      if (state.emittedDelta) {
        // Часть ответа уже ушла клиенту: повторять запрос нельзя.
        throw error;
      }

      this.logger.warn(
        `LLM-адаптер ${adapter.provider}: стриминг недоступен (${describeError(error)}), fallback на обычный режим`,
      );

      return await this.trackedLlmCall(route, () => adapter.chat(request));
    }
  }

  /**
   * Стриминг OpenAI-совместимого клиента. Накапливает чанки, чтобы вернуть
   * готовое сообщение; при сбое сохраняет полученный usage в состоянии
   * попытки — по нему резерв сверяется, а не возвращается целиком.
   */
  private async *streamClientAttempt(
    client: ChatOpenAI,
    route: LlmRouteSelection | undefined,
    messages: BaseMessage[],
    tools: StructuredToolInterface[],
    systemPrompt: string,
    state: StreamAttemptState,
  ): AsyncGenerator<ChatStreamChunk, AIMessage, unknown> {
    const model = tools.length > 0 ? client.bindTools(tools) : client;
    let accumulated: AIMessageChunk | undefined;

    try {
      for await (const chunk of await model.stream(
        withLanguageInstruction(messages, systemPrompt),
      )) {
        accumulated = accumulated ? accumulated.concat(chunk) : chunk;

        if (chunk.text) {
          state.emittedDelta = true;
          yield { type: 'delta', text: chunk.text };
        }
      }
    } catch (error) {
      this.recordLlmError(route, error);
      state.partialUsage = accumulated?.usage_metadata;
      throw error;
    }

    return accumulated
      ? new AIMessage({
          content: accumulated.content,
          tool_calls: accumulated.tool_calls,
          invalid_tool_calls: accumulated.invalid_tool_calls,
          usage_metadata: accumulated.usage_metadata,
        })
      : new AIMessage('');
  }

  /** JSON-событие переключения на следующий маршрут fallback-цепочки. */
  private logRouterFallback(
    from: LlmRouteSelection | undefined,
    to: LlmRouteSelection | undefined,
    error: unknown,
    taskType: string,
  ): void {
    this.logger.warn(
      JSON.stringify({
        event: 'gen_ai.router.fallback',
        from: from?.name ?? 'env',
        to: to?.name ?? 'env',
        reason: describeError(error),
        taskType: from?.taskType ?? to?.taskType ?? taskType,
      }),
    );
  }

  /** Текст эхо-заглушки, когда LLM не настроен. */
  private echoText(messages: BaseMessage[]): string {
    const lastUserMessage = [...messages]
      .reverse()
      .find((message) => message instanceof HumanMessage);

    return `LLM not configured: ${messageContentToText(lastUserMessage?.content ?? '')}`;
  }

  /** Эхо-заглушка как сообщение модели (нестримовый путь). */
  private echoMessage(messages: BaseMessage[]): AIMessage {
    return new AIMessage(this.echoText(messages));
  }

  /**
   * Адаптер для провайдера из маршрута. `providerType` может отсутствовать
   * в старых записях и в маршрутах, созданных до появления поля, поэтому
   * читаем его защищённо и по умолчанию считаем провайдера OpenAI-совместимым.
   */
  private resolveAdapter(
    route?: LlmRouteSelection,
  ): NativeProviderAdapter | null {
    if (!route) {
      return null;
    }

    const providerType = normalizeProviderType(
      (route as LlmRouteSelection & { providerType?: string }).providerType,
    );

    if (!isNativeProviderType(providerType)) {
      return null;
    }

    if (providerType === 'YandexGPT') {
      const tokenEnvVar = route.apiKeyEnvVar ?? 'YANDEX_IAM_TOKEN';

      return new YandexAdapter({
        modelName: route.modelName,
        iamToken: process.env[tokenEnvVar] ?? process.env.YANDEX_IAM_TOKEN,
      });
    }

    return new GigaChatAdapter({ model: route.modelName });
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
  private async getSystemPrompt(memoryContext?: string): Promise<string> {
    let systemPrompt = DEFAULT_SYSTEM_PROMPT;

    if (this.promptsService) {
      try {
        systemPrompt = await this.promptsService.getActiveSystemPrompt();
      } catch {
        systemPrompt = DEFAULT_SYSTEM_PROMPT;
      }
    }

    return withMemoryContext(systemPrompt, memoryContext);
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
 * Добавляет к системному промпту блок «Долговременная память». Пустой
 * контекст (память не настроена или ничего не найдено) промпт не меняет.
 */
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

/** Суммарное число токенов в usage ответа модели (0 при отсутствии данных). */
function totalTokens(usage: AIMessage['usage_metadata']): number {
  const tokens =
    usage?.total_tokens ??
    (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0);

  return Number.isFinite(tokens) ? Math.max(0, tokens) : 0;
}

/** Безопасное описание ошибки для логов (без тел запросов и секретов). */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'Error'
      ? error.message
      : `${error.name}: ${error.message}`;
  }

  return String(error);
}

/**
 * Приводит вход `route` к массиву: одиночный маршрут — обратная
 * совместимость, `undefined` или пустой массив — env-fallback.
 */
function normalizeRouteChain(route?: LlmRouteInput): LlmRouteSelection[] {
  if (route === undefined) {
    return [];
  }

  return isRouteChain(route) ? [...route] : [route];
}

function isRouteChain(
  route: LlmRouteInput,
): route is readonly LlmRouteSelection[] {
  return Array.isArray(route);
}

/** Единый ответ клиенту, когда вся fallback-цепочка недоступна (502). */
export function llmUnavailableError(): ApiException {
  return new ApiException({
    statusCode: HttpStatus.BAD_GATEWAY,
    error: 'Bad Gateway',
    code: ERROR_KEYS.llmUnavailable,
    message: LLM_ROUTES_UNAVAILABLE_MESSAGE,
  });
}

/**
 * Признаки временной ошибки провайдера, при которой имеет смысл переключиться
 * на следующий маршрут fallback-цепочки: HTTP 429, HTTP 5xx, таймауты
 * (AbortError/TimeoutError) и обрывы соединения (ETIMEDOUT/ECONNRESET).
 * 400/401/403 — ошибки конфигурации или доступа: повтор не поможет.
 */
export function isRetriableLlmError(error: unknown): boolean {
  const status = httpStatusOf(error);

  if (status !== null) {
    return status === 429 || status >= 500;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  if (
    error.name === 'AbortError' ||
    error.name === 'TimeoutError' ||
    error.name === 'APIConnectionTimeoutError' ||
    error.name === 'APIConnectionError'
  ) {
    return true;
  }

  return RETRIABLE_ERROR_PATTERN.test(error.message);
}

/**
 * HTTP-статус из ошибки провайдера: LangChain/axios кладут его в `status`,
 * `statusCode` или `response.status`; нативные адаптеры добавляют статус в
 * текст сообщения (`GigaChat: HTTP 500`).
 */
function httpStatusOf(error: unknown): number | null {
  if (error === null || typeof error !== 'object') {
    return null;
  }

  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
  };
  const raw =
    candidate.status ?? candidate.statusCode ?? candidate.response?.status;
  const parsed =
    typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);

  return Number.isInteger(parsed) && parsed >= 100 && parsed <= 599
    ? parsed
    : null;
}

/** Статусы/коды, которые считаются временной ошибкой провайдера. */
const RETRIABLE_ERROR_PATTERN =
  /(?:^|\D)(?:429|5\d\d)(?:\D|$)|timeout|timed out|таймаут|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|connection reset|network error|fetch failed/i;

/** Проверяет, что все перечисленные env-переменные заданы. */
function hasEnv(...names: string[]): boolean {
  return names.every((name) => {
    const value = process.env[name];

    return value !== undefined && value !== '';
  });
}

/**
 * Собирает разрешённые секреты из окружения Gateway для песочницы.
 */
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
