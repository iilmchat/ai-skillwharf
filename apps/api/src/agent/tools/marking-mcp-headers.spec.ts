import { describe, expect, it, vi } from 'vitest';
import type { ProviderKeysService } from '../../integrations/keys/provider-keys.service.js';
import {
  providerCredentialHeaders,
  MarketplaceMcpService,
} from './marketplace-mcp.service.js';

describe('MCP-заголовки маркировки (MARK-42.2)', () => {
  it('передаёт X-Marking-Token и X-Marking-Inn', () => {
    expect(
      providerCredentialHeaders('chestny_znak', {
        source: 'user',
        markingToken: 'mark-token',
        markingInn: '7700000000',
      }),
    ).toEqual({
      'X-Marking-Token': 'mark-token',
      'X-Marking-Inn': '7700000000',
    });
  });

  it('без кредов не отправляет заголовки', () => {
    expect(
      providerCredentialHeaders('chestny_znak', { source: 'env' }),
    ).toEqual({});
  });

  it('credentialsFor читает ключи пользователя', async () => {
    const providerKeys = {
      markingKeys: vi.fn(async () => ({
        token: 'mark-token',
        inn: '7700000000',
        source: 'user' as const,
      })),
    };
    const service = new MarketplaceMcpService(
      providerKeys as unknown as ProviderKeysService,
    );

    const credentials = await service.credentialsFor('chestny_znak', 'user-1');

    expect(providerKeys.markingKeys).toHaveBeenCalledWith('user-1');
    expect(providerCredentialHeaders('chestny_znak', credentials!)).toEqual(
      expect.objectContaining({ 'X-Marking-Token': 'mark-token' }),
    );
  });

  it('endpoint берётся из MARKING_MCP_URL', () => {
    const previous = process.env.MARKING_MCP_URL;

    process.env.MARKING_MCP_URL = 'http://marking-mcp:5013';

    try {
      expect(new MarketplaceMcpService().endpointFor('chestny_znak')).toBe(
        'http://marking-mcp:5013',
      );
    } finally {
      if (previous === undefined) {
        delete process.env.MARKING_MCP_URL;
      } else {
        process.env.MARKING_MCP_URL = previous;
      }
    }
  });
});
