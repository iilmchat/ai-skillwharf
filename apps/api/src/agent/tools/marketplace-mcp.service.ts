import { Injectable, Logger, Optional } from '@nestjs/common';
import { SkillManifestSchema } from '@skillwharf/shared';
import { marketplaceUnavailableError } from '../../common/api-error.js';
import { ProviderKeysService } from '../../integrations/keys/provider-keys.service.js';
import { McpClient } from './mcp-client.js';
import {
  McpGateway,
  mcpUnavailableError,
  type McpProvider,
} from './mcp-gateway.js';
import {
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
}

/** MCP-инструмент, которым пользуется навык провайдера. */
const PROVIDER_TOOL: Readonly<Record<McpProvider, string>> = {
  ozon: OZON_MCP_TOOL_NAME,
  wb: WB_MCP_TOOL_NAME,
};

/** Переменные окружения с ключами провайдера. */
const PROVIDER_KEY_ENV: Readonly<Record<McpProvider, readonly string[]>> = {
  ozon: ['OZON_CLIENT_ID', 'OZON_API_KEY'],
  wb: ['WB_API_TOKEN'],
};

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

  const fromEnv =
    platform === 'ozon' ? process.env.OZON_MCP_URL : process.env.WB_MCP_URL;

  return fromEnv === undefined || fromEnv.trim() === '' ? null : fromEnv.trim();
}

/**
 * Endpoint провайдера по манифестам навыков.
 *
 * Ищем навык, который объявляет MCP-инструмент провайдера
 * (`ozon_mcp_call`/`wb_mcp_call`) и задаёт `mcp_endpoint`.
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

/** Есть ли в окружении ключи провайдера (без них MCP вернёт ошибку). */
function hasProviderKeys(platform: McpProvider): boolean {
  return PROVIDER_KEY_ENV[platform].every((name) => {
    const value = process.env[name];

    return value !== undefined && value !== '';
  });
}

/**
 * Единая точка вызова MCP-провайдеров (Ozon/WB).
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

  /** Доступен ли провайдер по ключам окружения. */
  isConfigured(platform: McpProvider): boolean {
    return hasProviderKeys(platform);
  }

  /**
   * Ключи провайдера: сначала подключение пользователя, затем env.
   *
   * MCP-серверы Ozon/WB аутентифицируются своими env-ключами (один набор на
   * контейнер), поэтому пользовательские ключи здесь — источник истины для
   * гейта и аудита, а не заголовок запроса (см. KI-064).
   */
  async credentialsFor(
    platform: McpProvider,
    userId?: string,
  ): Promise<MarketplaceCredentials | null> {
    if (this.providerKeys !== undefined) {
      if (platform === 'ozon') {
        const resolved = await this.providerKeys.ozonKeys(userId);

        if (resolved !== null) {
          return {
            source: resolved.source,
            clientId: resolved.clientId,
            apiKey: resolved.apiKey,
          };
        }
      } else {
        const resolved = await this.providerKeys.wildberriesToken(userId);

        if (resolved !== null) {
          return { source: resolved.source, token: resolved.token };
        }
      }
    }

    return hasProviderKeys(platform)
      ? { source: 'env' }
      : null;
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
    const credentials = await this.credentialsFor(platform, options.userId);

    if (credentials === null) {
      throw marketplaceUnavailableError(
        platform === 'ozon'
          ? 'Ozon не подключён: добавьте Client ID и API Key в разделе «Интеграции» или задайте OZON_CLIENT_ID/OZON_API_KEY'
          : 'Wildberries не подключён: добавьте API Token в разделе «Интеграции» или задайте WB_API_TOKEN',
      );
    }

    if (!hasProviderKeys(platform)) {
      // Ключи пользователя не могут аутентифицировать MCP-контейнер: он читает
      // Ozon/WB-ключи из своего окружения (один набор на сервер).
      throw marketplaceUnavailableError(
        platform === 'ozon'
          ? 'Ключи Ozon сохранены, но MCP-сервер не сконфигурирован: задайте OZON_CLIENT_ID/OZON_API_KEY в окружении MCP-контейнера (KI-064)'
          : 'Токен WB сохранён, но MCP-сервер не сконфигурирован: задайте WB_API_TOKEN в окружении MCP-контейнера (KI-064)',
      );
    }

    this.logger.debug(
      JSON.stringify({
        event: 'mcp.credentials',
        provider: platform,
        source: credentials.source,
      }),
    );

    const gateway = this.gateway(platform, options);

    if (gateway === null) {
      throw mcpUnavailableError();
    }

    return gateway.call({ action, params });
  }

  private gateway(
    platform: McpProvider,
    options: MarketplaceCallOptions,
  ): McpGateway | null {
    const endpoint = this.endpointFor(platform, options);
    const client = this.client(platform, endpoint, options.authToken);

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
    authToken?: string,
  ): McpClient | null {
    if (endpoint === null) {
      return null;
    }

    const cached = this.clients.get(endpoint);

    if (cached !== undefined) {
      return cached;
    }

    const token = authToken ?? process.env.MCP_AUTH_TOKEN;
    const client = new McpClient({
      baseUrl: endpoint,
      ...(token === undefined || token === '' ? {} : { authToken: token }),
    });

    this.clients.set(endpoint, client);
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
