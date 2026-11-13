import { Injectable, Logger } from '@nestjs/common';
import { SkillManifestSchema } from '@skillwharf/shared';
import { marketplaceUnavailableError } from '../../common/api-error.js';
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

  /** Доступен ли провайдер по ключам окружения. */
  isConfigured(platform: McpProvider): boolean {
    return hasProviderKeys(platform);
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
    if (!hasProviderKeys(platform)) {
      throw marketplaceUnavailableError(
        platform === 'ozon'
          ? 'Ozon API keys not configured'
          : 'WB API token not configured',
      );
    }

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
