import { describe, expect, it, vi } from 'vitest';
import { ApiException } from '../common/api-error.js';
import { ERROR_KEYS } from '../i18n/error-keys.js';
import { AgentToolsService } from './agent-tools.service.js';

const runCommand = vi.fn(async () => 'ok');

const service = new AgentToolsService({
  runCommand,
} as unknown as ConstructorParameters<typeof AgentToolsService>[0]);

describe('AgentToolsService', () => {
  it('отдаёт базовые инструменты в виде JSON Schema', () => {
    const descriptors = service.buildDescriptors([]);
    const sandbox = descriptors.find(
      (descriptor) => descriptor.name === 'execute_sandbox_code',
    );

    expect(descriptors.map((descriptor) => descriptor.name)).toEqual([
      'execute_sandbox_code',
      'web_search',
      'exec',
    ]);
    expect(sandbox?.parameters).toMatchObject({
      type: 'object',
      properties: { code: { type: 'string' } },
    });
    expect(sandbox?.parameters.$schema).toBeUndefined();
  });

  it('валидирует аргументы и вызывает песочницу', async () => {
    await service.execute('exec', { command: 'echo hi' });

    expect(runCommand).toHaveBeenCalledWith(
      'echo hi',
      {},
      { egress: undefined },
    );
  });

  it('не пропускает аргументы не по схеме', async () => {
    await expect(service.execute('exec', { command: 42 })).rejects.toThrow();
  });

  it('отдаёт marketplace_unavailable, если ключи маркетплейса не заданы', async () => {
    delete process.env.OZON_CLIENT_ID;
    delete process.env.OZON_API_KEY;

    const error: unknown = await service
      .execute('ozon_mcp_call', { action: 'get_products', params: {} })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).getResponse()).toMatchObject({
      statusCode: 503,
      code: ERROR_KEYS.marketplaceUnavailable,
    });
  });
});
