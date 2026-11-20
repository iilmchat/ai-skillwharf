import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { parseSkillFile } from '../../skills/skill-file.js';
import { getToolPolicy } from '../../security/policy/tool-policies.js';
import type { MarketplaceMcpService } from './marketplace-mcp.service.js';
import {
  edoGetDocumentDetails,
  edoListIncomingUpd,
  edoPrepareSignPacket,
  edoReconcileWithErp,
  reconcileDocumentWithOrder,
  type EdoDocumentDetails,
} from './edo-tools.js';

const document: EdoDocumentDetails = {
  id: 'doc-1',
  title: 'УПД №42',
  supplier: 'ООО Поставщик',
  inn: '7700000000',
  items: [
    { name: 'Болт М8', quantity: 10, priceRub: 100, vatRub: 200 },
    { name: 'Гайка М8', quantity: 20, priceRub: 5 },
  ],
  totalRub: 1100,
};
const orderItems = [
  { name: 'Болт М8', quantity: 10, priceRub: 100 },
  { name: 'Гайка М8', quantity: 20, priceRub: 5 },
];

function mcpReturning(value: unknown) {
  return {
    call: vi.fn(async () => JSON.stringify(value)),
  } as unknown as MarketplaceMcpService;
}

describe('reconcileDocumentWithOrder (EDO-41.3)', () => {
  it('полное совпадение: matched=true', () => {
    expect(reconcileDocumentWithOrder(document, orderItems)).toEqual({
      matched: true,
      discrepancies: [],
    });
  });

  it('выявляет расхождение по цене в копейках', () => {
    const result = reconcileDocumentWithOrder(document, [
      ...orderItems.slice(0, 1),
      { name: 'Гайка М8', quantity: 20, priceRub: 6 },
    ]);

    expect(result.matched).toBe(false);
    expect(result.discrepancies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'price',
          expectedMinor: 600,
          actualMinor: 500,
        }),
        expect.objectContaining({ type: 'total' }),
      ]),
    );
  });

  it('выявляет расхождение по количеству и отсутствующие позиции', () => {
    const result = reconcileDocumentWithOrder(document, [
      { name: 'Болт М8', quantity: 11, priceRub: 100 },
      { name: 'Винт М6', quantity: 5, priceRub: 10 },
    ]);

    expect(result.discrepancies.map((item) => item.type)).toEqual(
      expect.arrayContaining(['quantity', 'missing', 'extra', 'total']),
    );
  });
});

describe('EDO tools (EDO-41.2/41.3)', () => {
  it('edo_list_incoming_upd валидирует аргументы и вызывает MCP', async () => {
    const mcp = mcpReturning({ documents: [{ id: 'doc-1', title: 'УПД №42' }] });
    const result = await edoListIncomingUpd(mcp, {
      provider: 'diadoc',
      limit: 5,
    });

    expect(JSON.parse(result).documents).toHaveLength(1);
    expect(mcp.call).toHaveBeenCalledWith(
      'diadoc',
      'edo_list_incoming_documents',
      { limit: 5 },
      {},
    );
  });

  it('edo_get_document_details возвращает спецификацию', async () => {
    const mcp = mcpReturning(document);

    const result = await edoGetDocumentDetails(mcp, {
      provider: 'sbis',
      documentId: 'doc-1',
    });

    expect(JSON.parse(result)).toMatchObject({ id: 'doc-1', totalRub: 1100 });
  });

  it('edo_reconcile_with_erp возвращает matched/discrepancies', async () => {
    const mcp = mcpReturning(document);

    const result = await edoReconcileWithErp(mcp, {
      provider: 'diadoc',
      documentId: 'doc-1',
      orderItems,
    });

    expect(JSON.parse(result)).toMatchObject({
      documentId: 'doc-1',
      matched: true,
      discrepancies: [],
    });
  });

  it('edo_prepare_sign_packet формирует пакет', async () => {
    const mcp = mcpReturning({
      provider: 'diadoc',
      documentId: 'doc-1',
      titleType: 'BuyerTitle',
      signer: 'Иванов И.И.',
      unsigned: true,
    });

    const result = await edoPrepareSignPacket(mcp, {
      provider: 'diadoc',
      documentIds: ['doc-1'],
      signer: 'Иванов И.И.',
    });

    expect(JSON.parse(result).packets).toEqual([
      expect.objectContaining({ documentId: 'doc-1', unsigned: true }),
    ]);
  });

  it('политика edo_prepare_sign_packet: обязательный HITL и цена 25 ₽', () => {
    expect(getToolPolicy('edo_prepare_sign_packet')).toMatchObject({
      approval: 'always',
      priceRub: 25,
    });
    expect(getToolPolicy('edo_reconcile_with_erp')).toMatchObject({
      approval: 'none',
      priceRub: 25,
    });
  });
});

describe('Стартовый навык ЭДО', () => {
  it('SKILL.md проходит валидацию манифеста', () => {
    const content = readFileSync(
      new URL('../../../../../starter-skills/edo-diadoc-sbis/SKILL.md', import.meta.url),
      'utf8',
    );
    const parsed = parseSkillFile(content);

    expect(parsed.success).toBe(true);
    expect(content).toContain('edo_prepare_sign_packet');
    expect(content).toContain('HITL');
  });
});
