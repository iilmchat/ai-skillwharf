import { describe, expect, it, vi } from 'vitest';
import type { ProviderKeysService } from '../../integrations/keys/provider-keys.service.js';
import {
  providerCredentialHeaders,
  MarketplaceMcpService,
} from './marketplace-mcp.service.js';

describe('EDO MCP headers (EDO-41.2)', () => {
  it('diadoc передаёт provider, apiKey, token и boxId', () => {
    expect(
      providerCredentialHeaders('diadoc', {
        source: 'user',
        edoProvider: 'diadoc',
        edoApiKey: 'api-1',
        edoToken: 'token-1',
        edoBoxId: 'box-1',
      }),
    ).toEqual({
      'X-Edo-Provider': 'diadoc',
      'X-Edo-Api-Key': 'api-1',
      'X-Edo-Token': 'token-1',
      'X-Edo-Box-Id': 'box-1',
    });
  });

  it('sbis не передаёт apiKey и берёт провайдера из платформы', () => {
    expect(
      providerCredentialHeaders('sbis', {
        source: 'user',
        edoToken: 'token-2',
        edoBoxId: 'box-2',
      }),
    ).toEqual({
      'X-Edo-Provider': 'sbis',
      'X-Edo-Token': 'token-2',
      'X-Edo-Box-Id': 'box-2',
    });
  });

  it('credentialsFor читает ключи пользователя по провайдеру', async () => {
    const providerKeys = {
      edoKeys: vi.fn(async (_userId: string | undefined, provider: string) => ({
        provider: provider as 'diadoc' | 'sbis',
        apiKey: provider === 'diadoc' ? 'api-1' : undefined,
        token: 'token',
        boxId: 'box',
        source: 'user' as const,
      })),
    };
    const service = new MarketplaceMcpService(
      providerKeys as unknown as ProviderKeysService,
    );

    const credentials = await service.credentialsFor('diadoc', 'user-1');

    expect(providerKeys.edoKeys).toHaveBeenCalledWith('user-1', 'diadoc');
    expect(providerCredentialHeaders('diadoc', credentials!)).toEqual(
      expect.objectContaining({
        'X-Edo-Provider': 'diadoc',
        'X-Edo-Api-Key': 'api-1',
      }),
    );
  });

  it('resolveMcpEndpoint использует EDO_MCP_URL', () => {
    const previous = process.env.EDO_MCP_URL;

    process.env.EDO_MCP_URL = 'http://edo-mcp:5012';

    try {
      const service = new MarketplaceMcpService();

      expect(service.endpointFor('sbis')).toBe('http://edo-mcp:5012');
    } finally {
      if (previous === undefined) {
        delete process.env.EDO_MCP_URL;
      } else {
        process.env.EDO_MCP_URL = previous;
      }
    }
  });
});
