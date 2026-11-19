import { describe, expect, it, vi } from 'vitest';
import { getToolPolicy } from '../../security/policy/tool-policies.js';
import { onecCreateOrder } from './erp-tools.js';
import type { MarketplaceMcpService } from './marketplace-mcp.service.js';

function mcp(reply: string) {
  const call = vi.fn(async () => reply);

  return { call, service: { call } as unknown as MarketplaceMcpService };
}

describe('Инструменты 1С (CONNECT-32.1)', () => {
  it('onec_create_order требует HITL и стоит 20 ₽ по политике', () => {
    const policy = getToolPolicy('onec_create_order');

    expect(policy).toMatchObject({
      name: 'onec_create_order',
      approval: 'always',
      priceRub: 20,
      egressRequested: true,
    });
    expect(getToolPolicy('onec_check_stock')?.priceRub).toBe(20);
  });

  it('вызывает MCP-действие onec_create_order с payload и не списывает до успеха', async () => {
    const { service, call } = mcp(
      JSON.stringify({ id: 'order-1', number: '000000001', sum: 300 }),
    );
    const beforeExecute = vi.fn(async () => undefined);

    const result = await onecCreateOrder(
      service,
      {
        counterpartyId: 'cp-1',
        items: [{ nomenclatureId: 'nom-1', quantity: 2, price: 150 }],
      },
      { beforeExecute },
    );

    expect(call).toHaveBeenCalledWith(
      '1c',
      'onec_create_order',
      {
        payload: {
          counterpartyId: 'cp-1',
          items: [{ nomenclatureId: 'nom-1', quantity: 2, price: 150 }],
        },
      },
      expect.objectContaining({ beforeExecute }),
    );
    expect(beforeExecute).toHaveBeenCalledTimes(1);
    expect(JSON.parse(result)).toMatchObject({
      orderId: 'order-1',
      positions: 1,
      counterpartyId: 'cp-1',
    });
  });

  it('не вызывает списание при ошибке провайдера', async () => {
    const { service } = mcp('not-json');
    const beforeExecute = vi.fn(async () => undefined);

    await expect(
      onecCreateOrder(
        service,
        {
          counterpartyId: 'cp-1',
          items: [{ nomenclatureId: 'nom-1', quantity: 1 }],
        },
        { beforeExecute },
      ),
    ).rejects.toThrow();
    expect(beforeExecute).not.toHaveBeenCalled();
  });
});
