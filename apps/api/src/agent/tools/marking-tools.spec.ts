import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { getToolPolicy } from '../../security/policy/tool-policies.js';
import { parseSkillFile } from '../../skills/skill-file.js';
import type { MarketplaceMcpService } from './marketplace-mcp.service.js';
import {
  markingCheckCodes,
  markingReportViolation,
  markingVerifyShipment,
  verifyMarkingShipment,
  type MarkingCodeStatus,
} from './marking-tools.js';

const OWNER_INN = '7700000000';
const GTIN_1 = '04600451023457';
const GTIN_2 = '04600451023464';
const CODE_1 = `01${GTIN_1}21AAAAAAAAAAA1`;
const CODE_2 = `01${GTIN_2}21BBBBBBBBBBB2`;
const NOW = new Date('2026-11-20T12:00:00Z');

const legalCodes: MarkingCodeStatus[] = [
  {
    code: CODE_1,
    status: 'ACTIVE',
    ownerInn: OWNER_INN,
    expiresAt: '2030-01-01T00:00:00Z',
    legalForSale: true,
    gtin: GTIN_1,
  },
  {
    code: CODE_2,
    status: 'ACTIVE',
    ownerInn: OWNER_INN,
    expiresAt: '2030-01-01T00:00:00Z',
    legalForSale: true,
    gtin: GTIN_2,
  },
];
const expectedItems = [
  { gtin: GTIN_1, quantity: 1 },
  { gtin: GTIN_2, quantity: 1 },
];

function mcpReturning(value: unknown) {
  return {
    call: vi.fn(async () => JSON.stringify(value)),
  } as unknown as MarketplaceMcpService;
}

describe('verifyMarkingShipment (MARK-42.3)', () => {
  it('легальная партия: valid=true', () => {
    expect(
      verifyMarkingShipment(legalCodes, expectedItems, OWNER_INN, NOW),
    ).toEqual({ valid: true, issues: [] });
  });

  it('выбывшая марка блокирует партию', () => {
    const result = verifyMarkingShipment(
      [{ ...legalCodes[0]!, status: 'RETIRED' }, legalCodes[1]!],
      expectedItems,
      OWNER_INN,
      NOW,
    );

    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.type)).toContain('retired');
  });

  it('чужой ИНН и просрочка тайла', () => {
    const result = verifyMarkingShipment(
      [
        { ...legalCodes[0]!, ownerInn: '9999999999' },
        { ...legalCodes[1]!, expiresAt: '2020-01-01T00:00:00Z' },
      ],
      expectedItems,
      OWNER_INN,
      NOW,
    );

    expect(result.issues.map((issue) => issue.type)).toEqual(
      expect.arrayContaining(['foreign_owner', 'expired']),
    );
  });

  it('недостача и пересорт по GTIN', () => {
    const result = verifyMarkingShipment(
      [legalCodes[0]!, { ...legalCodes[0]!, code: CODE_1 + 'x' }],
      expectedItems,
      OWNER_INN,
      NOW,
    );

    expect(result.issues.map((issue) => issue.type)).toEqual(
      expect.arrayContaining(['shortage', 'oversort']),
    );
  });
});

describe('Инструменты маркировки', () => {
  it('marking_check_codes вызывает MCP', async () => {
    const mcp = mcpReturning({ results: legalCodes });
    const result = await markingCheckCodes(mcp, { codes: [CODE_1, CODE_2] });

    expect(JSON.parse(result).results).toHaveLength(2);
    expect(mcp.call).toHaveBeenCalledWith(
      'chestny_znak',
      'marking_check_codes',
      { codes: [CODE_1, CODE_2] },
      {},
    );
  });

  it('marking_verify_shipment возвращает valid/issues', async () => {
    const mcp = mcpReturning({ results: legalCodes });

    const result = await markingVerifyShipment(mcp, {
      codes: [CODE_1, CODE_2],
      expectedOwnerInn: OWNER_INN,
      expectedItems,
      direction: 'shipment',
    });

    expect(JSON.parse(result)).toMatchObject({
      direction: 'shipment',
      valid: true,
      issues: [],
    });
  });

  it('marking_report_violation формирует акт', async () => {
    const mcp = mcpReturning({ reportId: 'act-1', status: 'draft' });

    const result = await markingReportViolation(mcp, {
      reason: 'Обнаружена выбывшая марка',
      codes: [CODE_1],
    });

    expect(JSON.parse(result).reportId).toBe('act-1');
    expect(mcp.call).toHaveBeenCalledWith(
      'chestny_znak',
      'marking_create_discrepancy_draft',
      expect.objectContaining({
        docId: 'manual-violation',
        discrepancies: expect.arrayContaining([
          expect.objectContaining({ reason: 'Обнаружена выбывшая марка' }),
        ]),
      }),
      {},
    );
  });

  it('политика HITL и цены', () => {
    expect(getToolPolicy('marking_report_violation')).toMatchObject({
      approval: 'always',
      priceRub: 15,
    });
    expect(getToolPolicy('marking_check_codes')).toMatchObject({
      approval: 'none',
      priceRub: 15,
    });
  });
});

describe('Стартовый навык маркировки', () => {
  it('SKILL.md валиден', () => {
    const content = readFileSync(
      new URL('../../../../../starter-skills/chestny-znak-marking/SKILL.md', import.meta.url),
      'utf8',
    );

    expect(parseSkillFile(content).success).toBe(true);
    expect(content).toContain('marking_verify_shipment');
    expect(content).toContain('HITL');
  });
});
