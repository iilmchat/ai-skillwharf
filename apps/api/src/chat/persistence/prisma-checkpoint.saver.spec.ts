import { describe, expect, it } from 'vitest';
import type {
  Checkpoint,
  CheckpointMetadata,
} from '@langchain/langgraph-checkpoint';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { createFakeCheckpointPrisma } from '../../../test/checkpointer/fake-checkpoint-store.js';
import { PrismaCheckpointSaver } from './prisma-checkpoint.saver.js';

const THREAD_ID = 'thread-1';
const OTHER_THREAD_ID = 'thread-2';

// uuid6 сортируется лексикографически по времени создания.
const CHECKPOINT_1 = '0192f0f0-0000-6000-8000-000000000001';
const CHECKPOINT_2 = '0192f0f0-0000-6000-8000-000000000002';
const CHECKPOINT_3 = '0192f0f0-0000-6000-8000-000000000003';

function createSaver() {
  const store = createFakeCheckpointPrisma();
  const saver = new PrismaCheckpointSaver(
    store.prisma as unknown as PrismaService,
  );

  return { saver, store };
}

function makeCheckpoint(
  id: string,
  channelValues: Record<string, unknown> = {},
): Checkpoint {
  return {
    v: 4,
    id,
    ts: new Date(0).toISOString(),
    channel_values: channelValues,
    channel_versions: {},
    versions_seen: {},
  };
}

function makeMetadata(
  overrides: Partial<CheckpointMetadata> = {},
): CheckpointMetadata {
  return { source: 'input', step: -1, parents: {}, ...overrides };
}

function threadConfig(extra: Record<string, unknown> = {}) {
  return {
    configurable: { thread_id: THREAD_ID, checkpoint_ns: '', ...extra },
  };
}

async function collectTuples(
  saver: PrismaCheckpointSaver,
  config: { configurable: Record<string, unknown> },
  options?: Parameters<typeof saver.list>[1],
) {
  const tuples = [];

  for await (const tuple of saver.list(config, options)) {
    tuples.push(tuple);
  }

  return tuples;
}

describe('PrismaCheckpointSaver.put / getTuple', () => {
  it('сохраняет checkpoint в BYTEA и отдаёт последний по умолчанию', async () => {
    const { saver, store } = createSaver();
    const checkpoint = makeCheckpoint(CHECKPOINT_1, {
      messages: ['привет'],
      counter: 1,
    });

    const returned = await saver.put(
      threadConfig(),
      checkpoint,
      makeMetadata(),
      {},
    );

    expect(returned).toEqual({
      configurable: {
        thread_id: THREAD_ID,
        checkpoint_ns: '',
        checkpoint_id: CHECKPOINT_1,
      },
    });
    expect(store.state.graphCheckpoints).toHaveLength(1);
    expect(store.state.graphCheckpoints[0]?.checkpointId).toBe(CHECKPOINT_1);
    expect(store.state.graphCheckpoints[0]?.payload).toBeInstanceOf(Uint8Array);
    expect(store.state.graphCheckpoints[0]?.parentCheckpointId).toBeNull();

    const tuple = await saver.getTuple(threadConfig());

    expect(tuple?.checkpoint.id).toBe(CHECKPOINT_1);
    expect(tuple?.checkpoint.channel_values).toEqual({
      messages: ['привет'],
      counter: 1,
    });
    expect(tuple?.config).toEqual(threadConfig({ checkpoint_id: CHECKPOINT_1 }));
    expect(tuple?.pendingWrites).toEqual([]);

    await saver.put(
      threadConfig({ checkpoint_id: CHECKPOINT_1 }),
      makeCheckpoint(CHECKPOINT_2),
      makeMetadata({ source: 'loop', step: 0 }),
      {},
    );

    const latest = await saver.getTuple(threadConfig());

    expect(latest?.checkpoint.id).toBe(CHECKPOINT_2);
    expect(latest?.metadata).toEqual({ source: 'loop', step: 0, parents: {} });
  });

  it('находит checkpoint по явному checkpoint_id', async () => {
    const { saver } = createSaver();

    await saver.put(
      threadConfig(),
      makeCheckpoint(CHECKPOINT_1, { value: 'first' }),
      makeMetadata(),
      {},
    );
    await saver.put(
      threadConfig({ checkpoint_id: CHECKPOINT_1 }),
      makeCheckpoint(CHECKPOINT_2, { value: 'second' }),
      makeMetadata({ source: 'loop', step: 0 }),
      {},
    );

    const tuple = await saver.getTuple(
      threadConfig({ checkpoint_id: CHECKPOINT_1 }),
    );

    expect(tuple?.checkpoint.channel_values).toEqual({ value: 'first' });
    expect(tuple?.config).toEqual(threadConfig({ checkpoint_id: CHECKPOINT_1 }));

    await expect(
      saver.getTuple(
        threadConfig({ checkpoint_id: '0192f0f0-0000-6000-8000-ffffffffffff' }),
      ),
    ).resolves.toBeUndefined();
  });

  it('возвращает parentConfig из config.configurable.checkpoint_id', async () => {
    const { saver } = createSaver();

    await saver.put(threadConfig(), makeCheckpoint(CHECKPOINT_1), makeMetadata(), {});
    await saver.put(
      threadConfig({ checkpoint_id: CHECKPOINT_1 }),
      makeCheckpoint(CHECKPOINT_2),
      makeMetadata({ source: 'loop', step: 0 }),
      {},
    );

    const tuple = await saver.getTuple(
      threadConfig({ checkpoint_id: CHECKPOINT_2 }),
    );

    expect(tuple?.parentConfig).toEqual({
      configurable: {
        thread_id: THREAD_ID,
        checkpoint_ns: '',
        checkpoint_id: CHECKPOINT_1,
      },
    });
  });

  it('требует thread_id в configurable', async () => {
    const { saver } = createSaver();

    await expect(saver.getTuple({ configurable: {} })).rejects.toThrow(
      /thread_id/,
    );
    await expect(
      saver.put({ configurable: {} }, makeCheckpoint(CHECKPOINT_1), makeMetadata(), {}),
    ).rejects.toThrow(/thread_id/);
  });
});

describe('PrismaCheckpointSaver.list', () => {
  async function seedThreeCheckpoints(saver: PrismaCheckpointSaver) {
    await saver.put(
      threadConfig(),
      makeCheckpoint(CHECKPOINT_1),
      makeMetadata(),
      {},
    );
    await saver.put(
      threadConfig({ checkpoint_id: CHECKPOINT_1 }),
      makeCheckpoint(CHECKPOINT_2),
      makeMetadata({ source: 'loop', step: 0 }),
      {},
    );
    await saver.put(
      threadConfig({ checkpoint_id: CHECKPOINT_2 }),
      makeCheckpoint(CHECKPOINT_3),
      makeMetadata({ source: 'loop', step: 1 }),
      {},
    );
  }

  it('отдаёт checkpoint’ы от новых к старым', async () => {
    const { saver } = createSaver();
    await seedThreeCheckpoints(saver);

    const tuples = await collectTuples(saver, threadConfig());

    expect(tuples.map((tuple) => tuple.checkpoint.id)).toEqual([
      CHECKPOINT_3,
      CHECKPOINT_2,
      CHECKPOINT_1,
    ]);
    expect(tuples[0]?.parentConfig?.configurable?.checkpoint_id).toBe(
      CHECKPOINT_2,
    );
  });

  it('поддерживает limit, before и filter', async () => {
    const { saver } = createSaver();
    await seedThreeCheckpoints(saver);

    const limited = await collectTuples(saver, threadConfig(), { limit: 2 });
    expect(limited.map((tuple) => tuple.checkpoint.id)).toEqual([
      CHECKPOINT_3,
      CHECKPOINT_2,
    ]);

    const before = await collectTuples(saver, threadConfig(), {
      before: threadConfig({ checkpoint_id: CHECKPOINT_3 }),
    });
    expect(before.map((tuple) => tuple.checkpoint.id)).toEqual([
      CHECKPOINT_2,
      CHECKPOINT_1,
    ]);

    const filtered = await collectTuples(saver, threadConfig(), {
      filter: { step: 0 },
    });
    expect(filtered.map((tuple) => tuple.checkpoint.id)).toEqual([
      CHECKPOINT_2,
    ]);

    const byId = await collectTuples(
      saver,
      threadConfig({ checkpoint_id: CHECKPOINT_3 }),
    );
    expect(byId.map((tuple) => tuple.checkpoint.id)).toEqual([CHECKPOINT_3]);
  });

  it('перечисляет checkpoint’ы разных тредов и не смешивает их', async () => {
    const { saver } = createSaver();
    await seedThreeCheckpoints(saver);
    await saver.put(
      { configurable: { thread_id: OTHER_THREAD_ID, checkpoint_ns: '' } },
      makeCheckpoint(CHECKPOINT_1),
      makeMetadata(),
      {},
    );

    const all = await collectTuples(saver, { configurable: {} });
    expect(all).toHaveLength(4);

    const other = await collectTuples(saver, {
      configurable: { thread_id: OTHER_THREAD_ID, checkpoint_ns: '' },
    });
    expect(other).toHaveLength(1);
  });
});

describe('PrismaCheckpointSaver.putWrites', () => {
  it('дедуплицирует обычные writes и сортирует pendingWrites по (taskPath, taskId, idx)', async () => {
    const { saver } = createSaver();
    await saver.put(
      threadConfig(),
      makeCheckpoint(CHECKPOINT_1),
      makeMetadata(),
      {},
    );
    const config = threadConfig({ checkpoint_id: CHECKPOINT_1 });

    await saver.putWrites(
      config,
      [
        ['messages', { value: 1 }],
        ['messages', { value: 2 }],
      ],
      'task-1',
    );
    // Повтор с тем же task_id/idx не перезаписывает обычные writes.
    await saver.putWrites(
      config,
      [
        ['messages', { value: 'ignored' }],
        ['messages', { value: 'ignored' }],
      ],
      'task-1',
    );
    await saver.putWrites(config, [['custom', 'value']], 'task-2', 'ns:1');
    await saver.putWrites(config, [['__interrupt__', { question: 'ok?' }]], 'task-1');

    const tuple = await saver.getTuple(config);

    expect(tuple?.pendingWrites).toEqual([
      ['task-1', '__interrupt__', { question: 'ok?' }],
      ['task-1', 'messages', { value: 1 }],
      ['task-1', 'messages', { value: 2 }],
      ['task-2', 'custom', 'value'],
    ]);
  });

  it('перезаписывает служебные writes (отрицательный idx)', async () => {
    const { saver, store } = createSaver();
    await saver.put(
      threadConfig(),
      makeCheckpoint(CHECKPOINT_1),
      makeMetadata(),
      {},
    );
    const config = threadConfig({ checkpoint_id: CHECKPOINT_1 });

    await saver.putWrites(config, [['__interrupt__', 'first']], 'task-1');
    await saver.putWrites(config, [['__interrupt__', 'second']], 'task-1');

    const tuple = await saver.getTuple(config);

    expect(tuple?.pendingWrites).toEqual([['task-1', '__interrupt__', 'second']]);
    expect(store.state.graphCheckpointWrites).toHaveLength(1);
    expect(store.state.graphCheckpointWrites[0]?.idx).toBe(-3);
  });

  it('требует thread_id и checkpoint_id в configurable', async () => {
    const { saver } = createSaver();

    await expect(
      saver.putWrites(threadConfig(), [['channel', 1]], 'task-1'),
    ).rejects.toThrow(/checkpoint_id/);
    await expect(
      saver.putWrites(
        { configurable: { checkpoint_id: CHECKPOINT_1 } },
        [['channel', 1]],
        'task-1',
      ),
    ).rejects.toThrow(/thread_id/);
  });
});

describe('PrismaCheckpointSaver.deleteThread', () => {
  it('удаляет checkpoint’ы и writes только указанного треда', async () => {
    const { saver, store } = createSaver();
    await saver.put(threadConfig(), makeCheckpoint(CHECKPOINT_1), makeMetadata(), {});
    await saver.putWrites(
      threadConfig({ checkpoint_id: CHECKPOINT_1 }),
      [['messages', 'value']],
      'task-1',
    );
    await saver.put(
      { configurable: { thread_id: OTHER_THREAD_ID, checkpoint_ns: '' } },
      makeCheckpoint(CHECKPOINT_2),
      makeMetadata(),
      {},
    );
    await saver.putWrites(
      {
        configurable: {
          thread_id: OTHER_THREAD_ID,
          checkpoint_ns: '',
          checkpoint_id: CHECKPOINT_2,
        },
      },
      [['messages', 'other']],
      'task-1',
    );

    await saver.deleteThread(THREAD_ID);

    await expect(saver.getTuple(threadConfig())).resolves.toBeUndefined();
    expect(store.state.graphCheckpoints).toHaveLength(1);
    expect(store.state.graphCheckpointWrites).toHaveLength(1);
    expect(store.state.graphCheckpoints[0]?.threadId).toBe(OTHER_THREAD_ID);
  });
});
