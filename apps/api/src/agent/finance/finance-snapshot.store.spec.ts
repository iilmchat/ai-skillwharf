import { describe, expect, it } from 'vitest';
import { FinanceSnapshotStore } from './finance-snapshot.store.js';

/**
 * Redis в тестах не поднимаем: передаём пустой URL, и хранилище работает в
 * режиме памяти — ровно как в одноинстансном окружении без REDIS_URL.
 */
function createStore(): FinanceSnapshotStore {
  return new FinanceSnapshotStore('');
}

const UNIT = {
  tool: 'unit-economics',
  marketplace: 'ozon',
  sku: 'SKU-1',
  dataAvailable: true,
  revenue: 1000,
};

describe('FinanceSnapshotStore (память без Redis)', () => {
  it('пишет и читает запись', async () => {
    const store = createStore();

    await store.record('user-1', 'unitEconomics', UNIT, 'ozon|SKU-1');

    const snapshots = await store.read('user-1');

    expect(snapshots.unitEconomics).toHaveLength(1);
    expect(snapshots.unitEconomics[0]?.value).toEqual(UNIT);
    expect(snapshots.unitEconomics[0]?.key).toBe('ozon|SKU-1');
    expect(Number.isNaN(Date.parse(snapshots.unitEconomics[0]?.recordedAt ?? ''))).toBe(false);
  });

  it('дедуплицирует по ключу и ставит свежую запись первой', async () => {
    const store = createStore();

    await store.record('user-1', 'unitEconomics', { ...UNIT, revenue: 1 }, 'ozon|SKU-1');
    await store.record('user-1', 'unitEconomics', { ...UNIT, revenue: 2 }, 'ozon|SKU-2');
    await store.record('user-1', 'unitEconomics', { ...UNIT, revenue: 3 }, 'ozon|SKU-1');

    const snapshots = await store.read('user-1');

    expect(snapshots.unitEconomics).toHaveLength(2);
    expect(snapshots.unitEconomics[0]?.value).toMatchObject({ revenue: 3 });
    expect(snapshots.unitEconomics[1]?.value).toMatchObject({ revenue: 2 });
  });

  it('ограничивает число записей по виду', async () => {
    const store = createStore();

    for (let index = 0; index < 15; index += 1) {
      await store.record(
        'user-1',
        'unitEconomics',
        { ...UNIT, sku: `SKU-${index}` },
        `ozon|SKU-${index}`,
      );
    }

    const snapshots = await store.read('user-1');

    expect(snapshots.unitEconomics).toHaveLength(10);
    expect(snapshots.unitEconomics[0]?.value).toMatchObject({ sku: 'SKU-14' });
  });

  it('без ключа дедупликации хранит все записи (последние)', async () => {
    const store = createStore();

    await store.record('user-1', 'profitLeaks', { run: 1 });
    await store.record('user-1', 'profitLeaks', { run: 2 });

    const snapshots = await store.read('user-1');

    expect(snapshots.profitLeaks).toHaveLength(2);
    expect(snapshots.profitLeaks[0]?.value).toEqual({ run: 2 });
  });

  it('не смешивает пользователей', async () => {
    const store = createStore();

    await store.record('user-1', 'fraudShield', { campaignId: '1' });
    await store.record('user-2', 'fraudShield', { campaignId: '2' });

    expect((await store.read('user-1')).fraudShield[0]?.value).toEqual({
      campaignId: '1',
    });
    expect((await store.read('user-2')).fraudShield[0]?.value).toEqual({
      campaignId: '2',
    });
  });

  it('пустое хранилище отдаёт пустые массивы, а не ошибку', async () => {
    const store = createStore();

    await expect(store.read('unknown')).resolves.toEqual({
      unitEconomics: [],
      profitLeaks: [],
      fraudShield: [],
    });
  });

  it('битые записи в памяти не ломают чтение', async () => {
    const store = createStore();

    await store.record('user-1', 'unitEconomics', UNIT, 'ozon|SKU-1');

    // Эмулируем повреждённое значение (старая версия формата).
    const internals = store as unknown as {
      memory: Map<string, Record<string, string>>;
    };
    internals.memory.set('user-1', { unitEconomics: '{not json' });

    await expect(store.read('user-1')).resolves.toEqual({
      unitEconomics: [],
      profitLeaks: [],
      fraudShield: [],
    });
  });
});
