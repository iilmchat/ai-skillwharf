/**
 * MCP Gateway — отдельный слой между LLM-инструментом и MCP-клиентом
 * (ADR 0004, п.1–2).
 *
 * Задачи слоя:
 *  - провалидировать аргументы вызова ДО отправки на MCP-сервер (Zod);
 *  - по `tools/list` проверить, что действие реально существует у провайдера
 *    (динамический discovery, KI-027);
 *  - ограничить вызов таймаутом и аккуратным retry;
 *  - смаппить любые сбои в единый JSON ошибки API (`ApiException`).
 *
 * Для известных действий провайдера применяется строгая схема параметров.
 * Если discovery доступен и успешен, неизвестные набору действия
 * отклоняются; если discovery недоступен, остаётся структурная проверка
 * `mcpToolCallSchema` — осознанный residual risk: список инструментов
 * MCP-сервера может расширяться без обновления gateway, но параметры всё
 * равно ограничены примитивами, длиной строк и количеством ключей.
 */
import { HttpStatus, Logger } from '@nestjs/common';
import { z } from 'zod';
import { ApiException, invalidRequestError } from '../../common/api-error.js';
import { ERROR_KEYS } from '../../i18n/error-keys.js';
import {
  McpTimeoutError,
  McpTransportError,
  safeDetail,
  type McpClient,
  type McpToolDescriptor,
} from './mcp-client.js';

export type { McpToolDescriptor } from './mcp-client.js';

/** MCP-провайдер, с которым работает gateway. */
export type McpProvider = 'ozon' | 'wb';

/** Таймаут одной попытки вызова MCP-сервера. */
export const MCP_DEFAULT_TIMEOUT_MS = 15_000;

/** Сколько раз повторяем вызов при временной ошибке транспорта. */
export const MCP_MAX_RETRIES = 1;

/** Пауза перед повтором временной ошибки. */
export const MCP_RETRY_BACKOFF_MS = 250;

/** Максимум ключей в `params`: защита от раздувания запроса. */
const MCP_MAX_PARAMS_KEYS = 50;

/** Ключ параметра: snake_case, до 64 символов. */
const mcpParamKeySchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

/** Скалярное значение параметра: строка/число/логическое/null. */
const mcpParamScalarSchema = z.union([
  z.string().max(4096),
  z.number(),
  z.boolean(),
  z.null(),
]);

/** Элемент массива параметра: только примитив, вложенные объекты запрещены. */
const mcpParamArrayItemSchema = z.union([
  z.string().max(1024),
  z.number(),
  z.boolean(),
]);

/** Значение параметра: примитив или массив примитивов (до 100 элементов). */
const mcpParamValueSchema = z.union([
  mcpParamScalarSchema,
  z.array(mcpParamArrayItemSchema).max(100),
]);

/** Имя MCP-действия: snake_case, 2–8 сегментов, до 64 символов. */
export const mcpActionSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+){1,7}$/)
  .max(64);

/**
 * Структурная схема аргументов MCP-вызова. Описывает только форму: имя
 * действия и «плоскую» запись примитивов. Семантику параметров известных
 * действий задают схемы из реестра ниже.
 */
export const mcpToolCallSchema = z
  .object({
    action: mcpActionSchema,
    params: z
      .record(mcpParamKeySchema, mcpParamValueSchema)
      .refine((params) => Object.keys(params).length <= MCP_MAX_PARAMS_KEYS, {
        message: `не более ${MCP_MAX_PARAMS_KEYS} ключей в params`,
      }),
  })
  .strict();

/** Общие параметры известных действий: только минимальные разумные поля. */
const shopIdSchema = z.string().min(1).max(64).optional();
const skuSchema = z.array(z.string().min(1).max(128)).max(100).optional();
const idsSchema = z.array(z.string().min(1).max(128)).max(100).optional();
const limitSchema = z.number().int().min(1).max(1000).optional();
const offsetSchema = z.number().int().min(0).optional();

/**
 * Строгие схемы параметров известных действий Ozon. Незнакомые ключи
 * (например, `period`-объект) отклоняются, чтобы LLM не протаскивала
 * произвольную структуру на MCP-сервер.
 */
const OZON_ACTION_SCHEMAS = {
  ozon_get_prices: z.strictObject({
    shop_id: shopIdSchema,
    sku: skuSchema,
    limit: limitSchema,
    offset: offsetSchema,
  }),
  ozon_orders_fbs: z.strictObject({
    shop_id: shopIdSchema,
    limit: limitSchema,
    offset: offsetSchema,
  }),
  ozon_reviews_list: z.strictObject({
    shop_id: shopIdSchema,
    ids: idsSchema,
    limit: limitSchema,
    offset: offsetSchema,
  }),
  ozon_product_info: z.strictObject({
    shop_id: shopIdSchema,
    sku: skuSchema,
  }),
  ozon_stocks: z.strictObject({
    shop_id: shopIdSchema,
    sku: skuSchema,
    limit: limitSchema,
    offset: offsetSchema,
  }),
};

/** Строгие схемы параметров известных действий Wildberries. */
const WB_ACTION_SCHEMAS = {
  wb_cards_list: z.strictObject({
    shop_id: shopIdSchema,
    limit: limitSchema,
    offset: offsetSchema,
  }),
  wb_finance_report: z.strictObject({
    shop_id: shopIdSchema,
    limit: limitSchema,
    offset: offsetSchema,
  }),
  wb_advert_list: z.strictObject({
    shop_id: shopIdSchema,
    limit: limitSchema,
    offset: offsetSchema,
  }),
  wb_orders_list: z.strictObject({
    shop_id: shopIdSchema,
    limit: limitSchema,
    offset: offsetSchema,
  }),
  wb_stocks: z.strictObject({
    shop_id: shopIdSchema,
    sku: skuSchema,
    limit: limitSchema,
    offset: offsetSchema,
  }),
};

/** Реестр известных действий по провайдерам. */
const KNOWN_ACTION_SCHEMAS: Record<McpProvider, Record<string, z.ZodType>> = {
  ozon: OZON_ACTION_SCHEMAS,
  wb: WB_ACTION_SCHEMAS,
};

/** Опции создания gateway. */
export interface McpGatewayOptions {
  provider: McpProvider;
  client: Pick<McpClient, 'callTool'>;
  /**
   * Ленивое one-time discovery инструментов провайдера (`McpClient.listTools`
   * либо его обёртка). Без колбэка gateway работает в structural-only режиме.
   */
  listTools?: () => Promise<readonly McpToolDescriptor[]>;
  timeoutMs?: number;
  maxRetries?: number;
}

/** Ошибка «MCP-сервер не сконфигурирован»: вызывающий слой решает, когда её вернуть. */
export function mcpUnavailableError(): ApiException {
  return new ApiException({
    statusCode: HttpStatus.SERVICE_UNAVAILABLE,
    error: 'Service Unavailable',
    code: ERROR_KEYS.mcpUnavailable,
    message: 'MCP-сервер не сконфигурирован',
  });
}

/**
 * Структурно валидирует аргументы MCP-вызова. Бросает `ApiException` 400 с
 * кодом `errors.invalid_request`, не раскрывая значения аргументов.
 */
export function validateMcpCall(input: unknown): {
  action: string;
  params: Record<string, unknown>;
} {
  const parsed = mcpToolCallSchema.safeParse(input);

  if (!parsed.success) {
    throw invalidRequestError(
      `MCP-вызов отклонён: ${describeIssues(parsed.error.issues)}`,
    );
  }

  return { action: parsed.data.action, params: parsed.data.params };
}

/**
 * Gateway одного MCP-провайдера: валидирует, вызывает и маппит ошибки в
 * единый формат API.
 */
export class McpGateway {
  private readonly provider: McpProvider;
  private readonly client: Pick<McpClient, 'callTool'>;
  private readonly listTools: McpGatewayOptions['listTools'];
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly logger = new Logger(McpGateway.name);
  private discovery: Promise<ReadonlySet<string> | null> | null = null;

  constructor(options: McpGatewayOptions) {
    this.provider = options.provider;
    this.client = options.client;
    this.listTools = options.listTools;
    this.timeoutMs = options.timeoutMs ?? MCP_DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? MCP_MAX_RETRIES;
  }

  /**
   * Валидирует аргументы и вызывает MCP-инструмент. Возвращает текстовый
   * результат как есть, а любые сбои превращает в `ApiException`.
   *
   * Порядок проверок: структурная Zod-схема → discovery-проверка действия →
   * строгая схема известного действия → `client.callTool`.
   */
  async call(input: unknown): Promise<string> {
    const { action, params } = validateMcpCall(input);
    await this.assertDiscoveredAction(action);
    const validatedParams = this.validateKnownAction(action, params);

    for (let attempt = 0; ; attempt += 1) {
      try {
        return await withTimeout(
          this.client.callTool(action, validatedParams),
          this.timeoutMs,
        );
      } catch (error) {
        if (error instanceof McpTimeoutError) {
          // Таймаут осознанно не повторяем: ожидание уже стоит один
          // `timeoutMs`, а повтор только удвоит задержку для пользователя.
          throw mcpTimeoutException(this.timeoutMs);
        }

        if (
          error instanceof McpTransportError &&
          error.transient &&
          attempt < this.maxRetries
        ) {
          await delay(MCP_RETRY_BACKOFF_MS);
          continue;
        }

        // JSON-RPC-ошибка провайдера детерминирована и не повторяется;
        // исчерпанный retry транспорта и неожиданные сбои клиента — 502.
        throw mcpProviderException(action);
      }
    }
  }

  /**
   * Отклоняет действие, которого нет в успешно полученном `tools/list`.
   * Неудачный или отключённый discovery не валит вызов: остаётся
   * structural-only режим (с JSON-логом один раз на инстанс).
   */
  private async assertDiscoveredAction(action: string): Promise<void> {
    const toolNames = await this.resolveToolNames();

    if (toolNames !== null && !toolNames.has(action)) {
      throw invalidRequestError(
        `MCP-действие ${action} не найдено в tools/list провайдера`,
      );
    }
  }

  /** Ленивое one-time discovery: один промис на инстанс (успех или сбой). */
  private resolveToolNames(): Promise<ReadonlySet<string> | null> {
    this.discovery ??= this.loadToolNames();

    return this.discovery;
  }

  /** Загружает имена инструментов; при любой ошибке — лог и null. */
  private async loadToolNames(): Promise<ReadonlySet<string> | null> {
    const listTools = this.listTools;

    if (listTools === undefined) {
      this.logToolsListUnavailable('listTools не сконфигурирован');

      return null;
    }

    try {
      const tools = await listTools();

      return new Set(tools.map((tool) => tool.name));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.logToolsListUnavailable(safeDetail(message));

      return null;
    }
  }

  /** JSON-лог недоступности discovery: без секретов и тел запросов. */
  private logToolsListUnavailable(message: string): void {
    this.logger.warn(
      JSON.stringify({
        event: 'mcp.tools_list_unavailable',
        provider: this.provider,
        message,
      }),
    );
  }

  /** Применяет строгую схему известного действия; неизвестное пропускает. */
  private validateKnownAction(
    action: string,
    params: Record<string, unknown>,
  ): Record<string, unknown> {
    const schema: z.ZodType | undefined =
      KNOWN_ACTION_SCHEMAS[this.provider][action];

    if (schema === undefined) {
      // Residual risk: неизвестное действие валидировано только структурно.
      return params;
    }

    const parsed = schema.safeParse(params);

    if (!parsed.success) {
      throw invalidRequestError(
        `MCP-вызов ${action} отклонён: ${describeIssues(parsed.error.issues)}`,
      );
    }

    return parsed.data as Record<string, unknown>;
  }
}

/** Безопасно (без значений) перечисляет пути проблем Zod. */
function describeIssues(issues: z.ZodError['issues']): string {
  const paths = issues
    .map((issue) => issue.path.map(String).join('.'))
    .filter((path) => path !== '');

  const unique = [...new Set(paths)].slice(0, 3);

  return unique.length === 0
    ? 'некорректные аргументы'
    : `некорректные аргументы: ${unique.join(', ')}`;
}

/** Единая ошибка 504: провайдер не ответил за отведённое время. */
function mcpTimeoutException(timeoutMs: number): ApiException {
  return new ApiException({
    statusCode: HttpStatus.GATEWAY_TIMEOUT,
    error: 'Gateway Timeout',
    code: ERROR_KEYS.mcpTimeout,
    message: `MCP-провайдер не ответил за ${timeoutMs} мс`,
  });
}

/** Единая ошибка 502: провайдер вернул ошибку или транспорт исчерпан. */
function mcpProviderException(action: string): ApiException {
  return new ApiException({
    statusCode: HttpStatus.BAD_GATEWAY,
    error: 'Bad Gateway',
    code: ERROR_KEYS.mcpProvider,
    message: `MCP-провайдер вернул ошибку при вызове ${action}`,
  });
}

/** Ограничивает попытку вызова по времени. */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new McpTimeoutError(`MCP: таймаут ${timeoutMs} мс`, { timeoutMs }),
        ),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** Пауза перед повтором временной ошибки. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
