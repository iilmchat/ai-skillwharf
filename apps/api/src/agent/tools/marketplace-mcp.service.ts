import { Injectable, Logger, Optional } from '@nestjs/common';
import { SkillManifestSchema } from '@skillwharf/shared';
import { createHash } from 'node:crypto';
import { marketplaceUnavailableError } from '../../common/api-error.js';
import { ProviderKeysService } from '../../integrations/keys/provider-keys.service.js';
import { McpClient } from './mcp-client.js';
import {
  McpGateway,
  mcpUnavailableError,
  type McpProvider,
} from './mcp-gateway.js';
import {
  BITRIX24_GET_DEAL_TOOL_NAME,
  MOYSKLAD_CHECK_STOCK_TOOL_NAME,
  OZON_MCP_TOOL_NAME,
  WB_MCP_TOOL_NAME,
} from './tool-schemas.js';

/** Снимок навыка: endpoint MCP берётся из манифеста. */
export interface MarketplaceSkillSnapshot {
  readonly name: string;
  readonly manifest: unknown;
}

/** Опции вызова MCP-провайдера. */
export interface MarketplaceCallOptions {
  /** Endpoint, вычисленный вызывающим слоем (эндпоинт инструмента-коннектора). */
  endpoint?: string;
  authToken?: string;
  /** Навыки пользователя: из манифеста берём `mcp_endpoint`. */
  skills?: readonly MarketplaceSkillSnapshot[];
  /** Владелец вызова: из БД берутся его ключи Ozon/WB (fallback — env). */
  userId?: string;
}

/** Найденные ключи провайдера и их источник. */
export interface MarketplaceCredentials {
  readonly source: 'user' | 'env';
  readonly clientId?: string;
  readonly apiKey?: string;
  readonly token?: string;
  /** Входящий вебхук Битрикс24 (секрет, только для заголовка). */
  readonly webhookUrl?: string;
  /** Креды 1С:Предприятие (OData). */
  readonly odataUrl?: string;
  readonly username?: string;
  readonly password?: string;
  /** Креды ЭДО (Diadoc/Sbis) для per-request заголовков EDO MCP. */
  readonly edoProvider?: 'diadoc' | 'sbis';
  readonly edoApiKey?: string;
  readonly edoToken?: string;
  readonly edoBoxId?: string;
  /** Креды ГИС МТ «Честный ЗНАК». */
  readonly markingToken?: string;
  readonly markingInn?: string;
}

/** Заголовки MCP-запроса с per-user кредами (`MCP-24.1`). */
export function providerCredentialHeaders(
  platform: McpProvider,
  credentials: MarketplaceCredentials,
): Record<string, string> {
  switch (platform) {
    case 'ozon':
      return credentials.clientId !== undefined &&
        credentials.apiKey !== undefined
        ? {
            'X-Ozon-Client-Id': credentials.clientId,
            'X-Ozon-Api-Key': credentials.apiKey,
          }
        : {};
    case 'wb':
      return credentials.token === undefined
        ? {}
        : { 'X-Wb-Api-Token': credentials.token };
    case 'bitrix24':
      return credentials.webhookUrl === undefined
        ? {}
        : { 'X-Bitrix24-Webhook-Url': credentials.webhookUrl };
    case 'moysklad':
      return credentials.token === undefined
        ? {}
        : { 'X-Moysklad-Token': credentials.token };
    case '1c':
      return credentials.odataUrl !== undefined &&
        credentials.username !== undefined &&
        credentials.password !== undefined
        ? {
            'X-1C-OData-Url': credentials.odataUrl,
            'X-1C-Username': credentials.username,
            'X-1C-Password': credentials.password,
          }
        : {};
    case 'diadoc':
    case 'sbis':
      return credentials.edoToken === undefined ||
        credentials.edoBoxId === undefined
        ? {}
        : {
            'X-Edo-Provider': credentials.edoProvider ?? platform,
            ...(credentials.edoApiKey === undefined
              ? {}
              : { 'X-Edo-Api-Key': credentials.edoApiKey }),
            'X-Edo-Token': credentials.edoToken,
            'X-Edo-Box-Id': credentials.edoBoxId,
          };
    case 'chestny_znak':
      return credentials.markingToken === undefined ||
        credentials.markingInn === undefined
        ? {}
        : {
            'X-Marking-Token': credentials.markingToken,
            'X-Marking-Inn': credentials.markingInn,
          };
  }
}

/** Ключ кеша клиента: endpoint + отпечаток кредов (без самих секретов). */
function clientCacheKey(
  endpoint: string,
  headers: Readonly<Record<string, string>>,
): string {
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(headers))
    .digest('hex');

  return `${endpoint}\u0000${fingerprint}`;
}

/** MCP-инструмент, которым пользуется навык провайдера. */
const PROVIDER_TOOL: Readonly<Record<McpProvider, string>> = {
  ozon: OZON_MCP_TOOL_NAME,
  wb: WB_MCP_TOOL_NAME,
  bitrix24: BITRIX24_GET_DEAL_TOOL_NAME,
  moysklad: MOYSKLAD_CHECK_STOCK_TOOL_NAME,
  '1c': 'onec_check_stock',
  diadoc: 'edo_list_incoming_upd',
  sbis: 'edo_list_incoming_upd',
  chestny_znak: 'marking_check_codes',
};

/** Переменные окружения с ключами провайдера. */
const PROVIDER_KEY_ENV: Readonly<Record<McpProvider, readonly string[]>> = {
  ozon: ['OZON_CLIENT_ID', 'OZON_API_KEY'],
  wb: ['WB_API_TOKEN'],
  bitrix24: ['BITRIX24_WEBHOOK_URL'],
  moysklad: ['MOYSKLAD_TOKEN'],
  '1c': ['ONEC_ODATA_URL', 'ONEC_USERNAME', 'ONEC_PASSWORD'],
  diadoc: ['EDO_MCP_URL'],
  sbis: ['EDO_MCP_URL'],
  chestny_znak: ['MARKING_MCP_URL'],
};

/** Переменная окружения с адресом MCP-сервера провайдера. */
const PROVIDER_MCP_URL_ENV: Readonly<Record<McpProvider, string>> = {
  ozon: 'OZON_MCP_URL',
  wb: 'WB_MCP_URL',
  bitrix24: 'BITRIX24_MCP_URL',
  moysklad: 'MOYSKLAD_MCP_URL',
  '1c': 'ONEC_MCP_URL',
  diadoc: 'EDO_MCP_URL',
  sbis: 'EDO_MCP_URL',
  chestny_znak: 'MARKING_MCP_URL',
};

/** Человеческое имя провайдера для сообщений об ошибке. */
const PROVIDER_LABEL: Readonly<Record<McpProvider, string>> = {
  ozon: 'Ozon',
  wb: 'Wildberries',
  bitrix24: 'Битрикс24',
  moysklad: 'МойСклад',
  '1c': '1С:Предприятие',
  diadoc: 'Контур.Диадок',
  sbis: 'СБИС',
  chestny_znak: 'Честный ЗНАК',
};

/** Названия ключей провайдера для подсказки в сообщении об ошибке. */
const PROVIDER_KEY_HINT: Readonly<Record<McpProvider, string>> = {
  ozon: 'Client ID и API Key',
  wb: 'API Token',
  bitrix24: 'входящий webhook',
  moysklad: 'токен API',
  '1c': 'OData URL, логин и пароль',
  diadoc: 'API Key, Token и Box ID Диадок',
  sbis: 'Token и Box ID СБИС',
  chestny_znak: 'токен ГИС МТ и ИНН',
};

/**
 * Провайдеры с историческим fallback на env внутри MCP-контейнера.
 *
 * После `MCP-24.1` ключи пользователя передаются в заголовках, а env API —
 * запасной источник. Если в API ключей нет вовсе, для этих провайдеров
 * сохраняется совместимость: MCP-сервер может быть настроен своим env.
 */
const CONTAINER_ENV_FALLBACK: ReadonlySet<McpProvider> = new Set([
  'bitrix24',
  'moysklad',
]);

/**
 * Адрес MCP-сервера: явный endpoint → `mcp_endpoint` навыка → env.
 * Адрес не хардкодится в коде: источник истины — манифест включённого навыка
 * (ADR 0004), env остаётся fallback для compose/dev.
 */
export function resolveMcpEndpoint(
  platform: McpProvider,
  manifestEndpoint?: string,
): string | null {
  const fromManifest = manifestEndpoint?.trim() ?? '';

  if (fromManifest !== '') {
    return fromManifest;
  }

  const fromEnv = process.env[PROVIDER_MCP_URL_ENV[platform]];

  return fromEnv === undefined || fromEnv.trim() === '' ? null : fromEnv.trim();
}

/**
 * Endpoint провайдера по манифестам навыков.
 *
 * Ищем навык, который объявляет MCP-инструмент провайдера
 * (`ozon_mcp_call`, `wb_mcp_call`, `bitrix24_get_deal`,
 * `moysklad_check_stock`) и задаёт `mcp_endpoint`.
 */
export function resolveProviderEndpointFromSkills(
  platform: McpProvider,
  skills: readonly MarketplaceSkillSnapshot[] | undefined,
): string | undefined {
  if (skills === undefined || skills.length === 0) {
    return undefined;
  }

  for (const skill of skills) {
    const parsed = SkillManifestSchema.safeParse(skill.manifest);

    if (!parsed.success) {
      continue;
    }

    const manifest = parsed.data;

    if (
      manifest.mcp_endpoint !== undefined &&
      (manifest.dependencies?.tools?.includes(PROVIDER_TOOL[platform]) ??
        false)
    ) {
      return manifest.mcp_endpoint;
    }
  }

  return undefined;
}

/** Непустое значение окружения или `null`. */
function readEnv(name: string): string | null {
  const value = process.env[name]?.trim() ?? '';

  return value === '' ? null : value;
}

/** Есть ли в окружении ключи провайдера (без них MCP вернёт ошибку). */
function hasProviderKeys(platform: McpProvider): boolean {
  return PROVIDER_KEY_ENV[platform].every((name) => readEnv(name) !== null);
}

/** Ключи из env API (fallback, когда `ProviderKeysService` не подключён). */
function envCredentials(
  platform: McpProvider,
): MarketplaceCredentials | null {
  switch (platform) {
    case 'ozon': {
      const clientId = readEnv('OZON_CLIENT_ID');
      const apiKey = readEnv('OZON_API_KEY');

      return clientId === null || apiKey === null
        ? null
        : { source: 'env', clientId, apiKey };
    }
    case 'wb': {
      const token = readEnv('WB_API_TOKEN');

      return token === null ? null : { source: 'env', token };
    }
    case 'bitrix24': {
      const webhookUrl = readEnv('BITRIX24_WEBHOOK_URL');

      return webhookUrl === null ? null : { source: 'env', webhookUrl };
    }
    case 'moysklad': {
      const token = readEnv('MOYSKLAD_TOKEN');

      return token === null ? null : { source: 'env', token };
    }
    case '1c': {
      const odataUrl = readEnv('ONEC_ODATA_URL');
      const username = readEnv('ONEC_USERNAME');
      const password = readEnv('ONEC_PASSWORD');

      return odataUrl === null || username === null || password === null
        ? null
        : { source: 'env', odataUrl, username, password };
    }
    case 'diadoc':
    case 'sbis': {
      // Общие env-переменные EDO-коннектора (EDO_PROVIDER/EDO_API_KEY/
      // EDO_TOKEN/EDO_BOX_ID) описаны в .env.example и infra/mcp/edo.
      const token = readEnv('EDO_TOKEN');
      const boxId = readEnv('EDO_BOX_ID');
      const apiKey = platform === 'diadoc' ? readEnv('EDO_API_KEY') : null;

      return token === null || boxId === null
        ? null
        : {
            source: 'env',
            edoProvider: platform,
            ...(apiKey === null ? {} : { edoApiKey: apiKey }),
            edoToken: token,
            edoBoxId: boxId,
          };
    }
    case 'chestny_znak': {
      const token = readEnv('MARKING_TOKEN');
      const inn = readEnv('MARKING_INN');

      return token === null || inn === null
        ? null
        : { source: 'env', markingToken: token, markingInn: inn };
    }
  }
}

/**
 * Единая точка вызова MCP-провайдеров (Ozon, WB, Битрикс24, МойСклад).
 *
 * Кеширует клиент по endpoint и gateway по клиенту: discovery `tools/list`
 * ленивый, повторное создание gateway на каждый вызов делало бы лишний
 * запрос. Ошибки маппит в единый JSON (`mcp_provider`, `mcp_timeout`,
 * `mcp_unavailable`, `marketplace_unavailable`).
 */
@Injectable()
export class MarketplaceMcpService {
  private readonly logger = new Logger(MarketplaceMcpService.name);
  private readonly clients = new Map<string, McpClient>();
  private readonly gateways = new WeakMap<McpClient, McpGateway>();

  constructor(
    @Optional() private readonly providerKeys?: ProviderKeysService,
  ) {}

  /** Доступен ли провайдер: ключи в env (Ozon/WB) или endpoint MCP-сервера. */
  isConfigured(platform: McpProvider): boolean {
    return CONTAINER_ENV_FALLBACK.has(platform)
      ? resolveMcpEndpoint(platform) !== null
      : hasProviderKeys(platform);
  }

  /**
   * Ключи провайдера: сначала подключение пользователя, затем env.
   *
   * Возвращаются сами значения (не только источник): `MCP-24.1` передаёт их
   * в заголовках MCP-запроса, поэтому MCP-контейнеру больше не нужен общий
   * env-ключ при наличии per-user подключения.
   */
  async credentialsFor(
    platform: McpProvider,
    userId?: string,
  ): Promise<MarketplaceCredentials | null> {
    if (this.providerKeys !== undefined) {
      switch (platform) {
        case 'ozon': {
          const resolved = await this.providerKeys.ozonKeys(userId);

          if (resolved !== null) {
            return {
              source: resolved.source,
              clientId: resolved.clientId,
              apiKey: resolved.apiKey,
            };
          }
          break;
        }
        case 'wb': {
          const resolved = await this.providerKeys.wildberriesToken(userId);

          if (resolved !== null) {
            return { source: resolved.source, token: resolved.token };
          }
          break;
        }
        case 'bitrix24': {
          const resolved = await this.providerKeys.bitrix24Webhook(userId);

          if (resolved !== null) {
            return {
              source: resolved.source,
              webhookUrl: resolved.webhookUrl,
            };
          }
          break;
        }
        case 'moysklad': {
          const resolved = await this.providerKeys.moyskladToken(userId);

          if (resolved !== null) {
            return { source: resolved.source, token: resolved.token };
          }
          break;
        }
        case '1c': {
          const resolved = await this.providerKeys.onecKeys(userId);

          if (resolved !== null) {
            return {
              source: 'user',
              odataUrl: resolved.odataUrl,
              username: resolved.username,
              password: resolved.password,
            };
          }
          break;
        }
        case 'diadoc':
        case 'sbis': {
          const resolved = await this.providerKeys.edoKeys(userId, platform);

          if (resolved !== null) {
            return {
              source: 'user',
              edoProvider: resolved.provider,
              ...(resolved.apiKey === undefined
                ? {}
                : { edoApiKey: resolved.apiKey }),
              edoToken: resolved.token,
              edoBoxId: resolved.boxId,
            };
          }
          break;
        }
        case 'chestny_znak': {
          const resolved = await this.providerKeys.markingKeys(userId);

          if (resolved !== null) {
            return {
              source: 'user',
              markingToken: resolved.token,
              markingInn: resolved.inn,
            };
          }
          break;
        }
      }
    }

    return envCredentials(platform);
  }

  /** Адрес MCP-сервера провайдера (null — не сконфигурирован). */
  endpointFor(
    platform: McpProvider,
    options: MarketplaceCallOptions = {},
  ): string | null {
    return (
      options.endpoint ??
      resolveProviderEndpointFromSkills(platform, options.skills) ??
      resolveMcpEndpoint(platform)
    );
  }

  /**
   * Вызывает MCP-инструмент и возвращает текстовый ответ сервера
   * (JSON-строка, как отдаёт `_json` в MCP-серверах).
   */
  async call(
    platform: McpProvider,
    action: string,
    params: Record<string, unknown>,
    options: MarketplaceCallOptions = {},
  ): Promise<string> {
    // Битрикс24/МойСклад вызываются только через MCP-сервер: без endpoint
    // ключи пользователя бесполезны.
    if (
      CONTAINER_ENV_FALLBACK.has(platform) &&
      this.endpointFor(platform, options) === null
    ) {
      throw marketplaceUnavailableError(
        `${PROVIDER_LABEL[platform]} не подключён: задайте ${PROVIDER_MCP_URL_ENV[platform]} или mcp_endpoint навыка`,
      );
    }

    const credentials = await this.credentialsFor(platform, options.userId);
    const headers =
      credentials === null ? {} : providerCredentialHeaders(platform, credentials);

    if (credentials === null) {
      const canUseContainerEnv =
        CONTAINER_ENV_FALLBACK.has(platform) &&
        this.endpointFor(platform, options) !== null;

      if (!canUseContainerEnv) {
        throw marketplaceUnavailableError(
          `${PROVIDER_LABEL[platform]} не подключён: добавьте ${PROVIDER_KEY_HINT[platform]} в разделе «Интеграции» или задайте ${PROVIDER_KEY_ENV[platform].join('/')}`,
        );
      }
    } else {
      this.logger.debug(
        JSON.stringify({
          event: 'mcp.credentials',
          provider: platform,
          source: credentials.source,
        }),
      );
    }

    const gateway = this.gateway(platform, options, headers);

    if (gateway === null) {
      throw mcpUnavailableError();
    }

    return gateway.call({ action, params });
  }

  private gateway(
    platform: McpProvider,
    options: MarketplaceCallOptions,
    headers: Readonly<Record<string, string>>,
  ): McpGateway | null {
    const endpoint = this.endpointFor(platform, options);
    const client = this.client(platform, endpoint, options.authToken, headers);

    if (client === null) {
      return null;
    }

    const cached = this.gateways.get(client);

    if (cached !== undefined) {
      return cached;
    }

    const gateway = new McpGateway({
      provider: platform,
      client,
      listTools: () => client.listTools(),
    });

    this.gateways.set(client, gateway);

    return gateway;
  }

  private client(
    platform: McpProvider,
    endpoint: string | null,
    authToken: string | undefined,
    headers: Readonly<Record<string, string>>,
  ): McpClient | null {
    if (endpoint === null) {
      return null;
    }

    const cacheKey = clientCacheKey(endpoint, headers);
    const cached = this.clients.get(cacheKey);

    if (cached !== undefined) {
      return cached;
    }

    const token = authToken ?? process.env.MCP_AUTH_TOKEN;
    const client = new McpClient({
      baseUrl: endpoint,
      ...(token === undefined || token === '' ? {} : { authToken: token }),
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
    });

    this.clients.set(cacheKey, client);
    this.logger.log(
      JSON.stringify({
        event: 'mcp.client_created',
        provider: platform,
        endpoint,
      }),
    );

    return client;
  }
}
