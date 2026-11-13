import { Injectable } from '@nestjs/common';
import { FinanceSnapshotStore } from '../agent/finance/finance-snapshot.store.js';
import {
  fraudAuditResultSchema,
  profitLeakResultSchema,
  unitEconomicsResultSchema,
  type FinanceOverviewResponse,
  type FraudShieldQuery,
  type ProfitLeaksQuery,
  type UnitEconomicsQuery,
} from './finance-contracts.js';

/** Ответ `/finance/unit-economics` (UI принимает `{ items }`). */
export interface UnitEconomicsListResponse {
  readonly dataAvailable: boolean;
  readonly reason?: string;
  readonly items: readonly unknown[];
  readonly updatedAt?: string;
}

/** Ответ `/finance/profit-leaks`. */
export interface ProfitLeaksListResponse {
  readonly dataAvailable: boolean;
  readonly reason?: string;
  readonly items: readonly unknown[];
  readonly updatedAt?: string;
}

/** Ответ `/finance/fraud-shield`: сам аудит либо честная «нет данных». */
export interface FraudShieldResponse {
  readonly dataAvailable: boolean;
  readonly reason?: string;
  readonly findings: readonly unknown[];
  readonly checks: readonly unknown[];
  readonly updatedAt?: string;
}

const NO_DATA_REASON =
  'Нет рассчитанных данных: запустите инструмент в чате — дашборд показывает результаты реальных MCP-вызовов Ozon/WB, а не заглушки.';

/**
 * Собирает финансовый дашборд из последних результатов инструментов агента.
 *
 * Источник данных — `FinanceSnapshotStore`, куда `AgentToolsService` пишет
 * только успешные ответы `FinanceToolsService` (реальные MCP-вызовы Ozon/WB).
 * REST не вызывает MCP сам: иначе чтение дашборда обходило бы оплату
 * навыков (Pay-per-Call/Pay-per-Outcome) и создавало бы побочные эффекты на
 * GET.
 */
@Injectable()
export class FinanceService {
  constructor(private readonly store: FinanceSnapshotStore) {}

  async overview(userId: string): Promise<FinanceOverviewResponse> {
    const snapshots = await this.store.read(userId);
    const unitEconomics = parseAll(
      snapshots.unitEconomics,
      unitEconomicsResultSchema,
    );
    const profitLeaks = parseAll(
      snapshots.profitLeaks,
      profitLeakResultSchema,
    );
    const fraudShield = parseFirst(
      snapshots.fraudShield,
      fraudAuditResultSchema,
    );
    const dataAvailable =
      unitEconomics.length > 0 ||
      profitLeaks.length > 0 ||
      fraudShield !== null;
    const updatedAt = latestTimestamp(snapshots);
    const period = periodOf(unitEconomics, profitLeaks, fraudShield);

    return {
      currency: 'RUB',
      ...(period === undefined ? {} : { period }),
      unitEconomics: unitEconomics.map((item) => item.value),
      profitLeaks: profitLeaks.map((item) => item.value),
      fraudShield: fraudShield === null ? null : fraudShield.value,
      dataAvailable,
      ...(dataAvailable ? {} : { reason: NO_DATA_REASON }),
      ...(updatedAt === undefined ? {} : { updatedAt }),
    };
  }

  async unitEconomics(
    userId: string,
    query: UnitEconomicsQuery,
  ): Promise<UnitEconomicsListResponse> {
    const snapshots = await this.store.read(userId);
    const parsed = parseAll(snapshots.unitEconomics, unitEconomicsResultSchema)
      .map((item) => item.value)
      .filter((item) => matchesUnitEconomics(item, query));
    const updatedAt = latestTimestamp(snapshots);

    return {
      dataAvailable: parsed.length > 0,
      ...(parsed.length === 0 ? { reason: NO_DATA_REASON } : {}),
      items: parsed,
      ...(updatedAt === undefined ? {} : { updatedAt }),
    };
  }

  async profitLeaks(
    userId: string,
    query: ProfitLeaksQuery,
  ): Promise<ProfitLeaksListResponse> {
    const snapshots = await this.store.read(userId);
    const parsed = parseAll(snapshots.profitLeaks, profitLeakResultSchema)
      .map((item) => item.value)
      .filter(
        (item) =>
          query.marketplace === undefined ||
          item.marketplace === query.marketplace,
      );
    const updatedAt = latestTimestamp(snapshots);

    return {
      dataAvailable: parsed.length > 0,
      ...(parsed.length === 0 ? { reason: NO_DATA_REASON } : {}),
      items: parsed,
      ...(updatedAt === undefined ? {} : { updatedAt }),
    };
  }

  async fraudShield(
    userId: string,
    query: FraudShieldQuery,
  ): Promise<FraudShieldResponse> {
    const snapshots = await this.store.read(userId);
    const candidates = parseAll(
      snapshots.fraudShield,
      fraudAuditResultSchema,
    ).map((item) => item.value);
    const audit =
      candidates.find(
        (item) =>
          query.campaignId === undefined ||
          item.campaignId === query.campaignId,
      ) ?? null;

    if (audit === null) {
      return {
        dataAvailable: false,
        reason:
          query.campaignId === undefined
            ? NO_DATA_REASON
            : `Нет рассчитанного аудита для кампании ${query.campaignId}: запустите fraud-shield-audit в чате.`,
        findings: [],
        checks: [],
      };
    }

    return {
      ...audit,
      findings: audit.findings,
      checks: audit.checks,
    };
  }
}

/** Разбирает записи схемой, отбрасывая несовместимые (после смены версии). */
function parseAll<T>(
  entries: readonly { readonly value: unknown }[],
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T } },
): Array<{ readonly value: T }> {
  const result: Array<{ readonly value: T }> = [];

  for (const entry of entries) {
    const parsed = schema.safeParse(entry.value);

    if (parsed.success && parsed.data !== undefined) {
      result.push({ value: parsed.data });
    }
  }

  return result;
}

function parseFirst<T>(
  entries: readonly { readonly value: unknown }[],
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T } },
): { readonly value: T } | null {
  return parseAll(entries, schema)[0] ?? null;
}

function matchesUnitEconomics(
  item: {
    readonly sku: string;
    readonly marketplace: 'ozon' | 'wb';
  },
  query: UnitEconomicsQuery,
): boolean {
  const skuMatches = query.sku === undefined || item.sku === query.sku;
  const marketMatches =
    query.marketplace === undefined || item.marketplace === query.marketplace;

  return skuMatches && marketMatches;
}

function latestTimestamp(
  snapshots: Record<
    string,
    readonly { readonly recordedAt: string }[]
  >,
): string | undefined {
  let latest: string | undefined;

  for (const entries of Object.values(snapshots)) {
    for (const entry of entries) {
      if (latest === undefined || entry.recordedAt > latest) {
        latest = entry.recordedAt;
      }
    }
  }

  return latest;
}

function periodOf(
  unitEconomics: ReadonlyArray<{
    readonly value: { readonly period?: { from: string; to: string } };
  }>,
  profitLeaks: ReadonlyArray<{
    readonly value: { readonly period?: { from: string; to: string } };
  }>,
  fraudShield: {
    readonly value: { readonly period?: { from: string; to: string } };
  } | null,
): { from: string; to: string } | undefined {
  return (
    unitEconomics[0]?.value.period ??
    profitLeaks[0]?.value.period ??
    fraudShield?.value.period
  );
}
