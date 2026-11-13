import { Inject, Injectable, Logger, Optional, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';

/** Виды финансовых результатов, которые видны в дашборде. */
export type FinanceSnapshotKind =
  | 'unitEconomics'
  | 'profitLeaks'
  | 'fraudShield';

/** Одна сохранённая запись: значение инструмента и время расчёта. */
export interface FinanceSnapshotEntry {
  readonly value: unknown;
  readonly recordedAt: string;
  /** Ключ дедупликации (например, `ozon|SKU-1`); `null` — без дедупликации. */
  readonly key: string | null;
}

export type FinanceSnapshots = Record<
  FinanceSnapshotKind,
  readonly FinanceSnapshotEntry[]
>;

/** Токен URL Redis: модуль передаёт `REDIS_URL`, тесты — пустую строку. */
export const FINANCE_SNAPSHOT_REDIS_URL = 'FINANCE_SNAPSHOT_REDIS_URL';

/** Сколько записей хранить по каждому виду (свежие первыми). */
const CAPACITY: Record<FinanceSnapshotKind, number> = {
  unitEconomics: 10,
  profitLeaks: 3,
  fraudShield: 3,
};

const KIND_VALUES: readonly FinanceSnapshotKind[] = [
  'unitEconomics',
  'profitLeaks',
  'fraudShield',
];

const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Хранилище последних финансовых результатов пользователя.
 *
 * Дашборд не пересчитывает финансы сам: он показывает то, что уже посчитали
 * инструменты агента (`FinanceToolsService`) на реальных данных MCP. Так
 * REST-чтение не обходит Pay-per-Call/Pay-per-Outcome и не делает
 * MCP-запросов на GET.
 *
 * Основное хранилище — Redis (общее для реплик API), резерв — память
 * процесса: без Redis дашборд работает в одном инстансе, а после рестарта
 * честно отдаёт `dataAvailable: false`.
 */
@Injectable()
export class FinanceSnapshotStore implements OnModuleDestroy {
  private readonly logger = new Logger(FinanceSnapshotStore.name);
  private readonly memory = new Map<
    string,
    Partial<Record<FinanceSnapshotKind, string>>
  >();
  private readonly redis: Redis | null;
  private readonly ttlSeconds: number;
  private redisDisabled = false;

  constructor(
    @Optional()
    @Inject(FINANCE_SNAPSHOT_REDIS_URL)
    redisUrl?: string,
  ) {
    const url = (redisUrl ?? process.env.REDIS_URL ?? '').trim();
    this.ttlSeconds = positiveInt(
      process.env.FINANCE_SNAPSHOT_TTL_SECONDS,
      DEFAULT_TTL_SECONDS,
    );

    if (url === '') {
      this.redis = null;

      return;
    }

    this.redis = new Redis(url, {
      lazyConnect: true,
      connectTimeout: 1_500,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    this.redis.on('error', (error: Error) => {
      if (!this.redisDisabled) {
        this.logger.warn(
          JSON.stringify({
            event: 'finance.snapshots.redis_unavailable',
            message: error.message,
          }),
        );
      }

      this.redisDisabled = true;
    });
  }

  /**
   * Сохраняет результат инструмента.
   *
   * `key` задаёт дедупликацию: новая запись с тем же ключом вытесняет старую,
   * поэтому таблица SKU не растёт бесконечно.
   */
  async record(
    userId: string,
    kind: FinanceSnapshotKind,
    value: unknown,
    key: string | null = null,
  ): Promise<void> {
    const existing = await this.readKind(userId, kind);
    const fresh: FinanceSnapshotEntry = {
      value,
      recordedAt: new Date().toISOString(),
      key,
    };
    const merged = [
      fresh,
      ...existing.filter((entry) => key === null || entry.key !== key),
    ].slice(0, CAPACITY[kind]);

    await this.writeKind(userId, kind, merged);
  }

  /** Читает сохранённые результаты; свежие — первыми. */
  async read(userId: string): Promise<FinanceSnapshots> {
    const raw = await this.readRaw(userId);

    return {
      unitEconomics: parseEntries(raw.unitEconomics),
      profitLeaks: parseEntries(raw.profitLeaks),
      fraudShield: parseEntries(raw.fraudShield),
    };
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis === null) {
      return;
    }

    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }

  private async readKind(
    userId: string,
    kind: FinanceSnapshotKind,
  ): Promise<readonly FinanceSnapshotEntry[]> {
    const raw = await this.readRaw(userId);

    return parseEntries(raw[kind]);
  }

  private async readRaw(
    userId: string,
  ): Promise<Partial<Record<FinanceSnapshotKind, string>>> {
    if (this.redis !== null && !this.redisDisabled) {
      try {
        const stored = await this.redis.hgetall(keyFor(userId));

        if (Object.keys(stored).length > 0) {
          return stored;
        }
      } catch (error) {
        this.disableRedis(error);
      }
    }

    return this.memory.get(userId) ?? {};
  }

  private async writeKind(
    userId: string,
    kind: FinanceSnapshotKind,
    entries: readonly FinanceSnapshotEntry[],
  ): Promise<void> {
    const payload = JSON.stringify(entries);

    if (this.redis !== null && !this.redisDisabled) {
      try {
        const key = keyFor(userId);

        await this.redis.hset(key, kind, payload);
        await this.redis.expire(key, this.ttlSeconds);

        return;
      } catch (error) {
        this.disableRedis(error);
      }
    }

    const current = this.memory.get(userId) ?? {};
    current[kind] = payload;
    this.memory.set(userId, current);
  }

  private disableRedis(error: unknown): void {
    if (this.redisDisabled) {
      return;
    }

    this.redisDisabled = true;
    this.logger.warn(
      JSON.stringify({
        event: 'finance.snapshots.redis_fallback',
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

function keyFor(userId: string): string {
  return `finance:snapshots:${userId}`;
}

/** Разбирает JSON-массив записей; битые элементы пропускает. */
function parseEntries(raw: string | undefined): FinanceSnapshotEntry[] {
  if (raw === undefined || raw === '') {
    return [];
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) {
    return [];
  }

  const entries: FinanceSnapshotEntry[] = [];

  for (const item of parsed) {
    if (!isRecord(item) || typeof item.recordedAt !== 'string') {
      continue;
    }

    if (!('value' in item)) {
      continue;
    }

    entries.push({
      value: item.value,
      recordedAt: item.recordedAt,
      key: typeof item.key === 'string' ? item.key : null,
    });
  }

  return entries;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export { KIND_VALUES };
