import { describe, expect, it } from 'vitest';
import {
  Annotation,
  Command,
  END,
  START,
  StateGraph,
  interrupt,
} from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { createFakeCheckpointPrisma } from '../../../test/checkpointer/fake-checkpoint-store.js';
import { PrismaCheckpointSaver } from './prisma-checkpoint.saver.js';

const THREAD_ID = 'conversation-42';

const ApprovalState = Annotation.Root({
  query: Annotation<string>({
    reducer: (_previous, next) => next,
    default: () => '',
  }),
  approved: Annotation<boolean>({
    reducer: (_previous, next) => next,
    default: () => false,
  }),
  outcome: Annotation<string>({
    reducer: (_previous, next) => next,
    default: () => '',
  }),
});

/**
 * Мини-граф с human-in-the-loop: узел останавливается на `interrupt()` и
 * продолжает только после `Command({ resume })`.
 */
function buildApprovalGraph(checkpointer: BaseCheckpointSaver) {
  return new StateGraph(ApprovalState)
    .addNode('approval', async (state: typeof ApprovalState.State) => {
      const resume: unknown = interrupt({
        question: `Approve ${state.query}?`,
      });
      const approved = isApproved(resume);

      return { approved, outcome: approved ? 'executed' : 'rejected' };
    })
    .addEdge(START, 'approval')
    .addEdge('approval', END)
    .compile({ checkpointer });
}

function isApproved(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'approved' in value &&
    (value as { approved?: unknown }).approved === true
  );
}

function threadConfig() {
  return { configurable: { thread_id: THREAD_ID } };
}

function createSaver(store: ReturnType<typeof createFakeCheckpointPrisma>) {
  return new PrismaCheckpointSaver(
    store.prisma as unknown as PrismaService,
  );
}

describe('restart durability', () => {
  it('новый saver и граф видят interrupt и возобновляют выполнение', async () => {
    const store = createFakeCheckpointPrisma();
    const config = threadConfig();

    // Первый запуск: граф доходит до interrupt и останавливается.
    const firstGraph = buildApprovalGraph(createSaver(store));
    const chunks: unknown[] = [];

    for await (const chunk of await firstGraph.stream(
      { query: 'send invoice' },
      config,
    )) {
      chunks.push(chunk);
    }

    expect(JSON.stringify(chunks)).toContain('__interrupt__');

    const interrupted = await firstGraph.getState(config);
    expect(interrupted.next).toEqual(['approval']);
    expect(
      interrupted.tasks.flatMap((task) => task.interrupts ?? []),
    ).toHaveLength(1);

    // Эмулируем рестарт API: новые инстансы saver'а и графа поверх той же БД.
    expect(store.state.graphCheckpoints.length).toBeGreaterThan(0);
    expect(store.state.graphCheckpointWrites.length).toBeGreaterThan(0);

    const secondGraph = buildApprovalGraph(createSaver(store));
    const restored = await secondGraph.getState(config);

    expect(restored.next).toEqual(['approval']);
    expect(
      restored.tasks.flatMap((task) => task.interrupts ?? [])[0]?.value,
    ).toEqual({ question: 'Approve send invoice?' });

    // Подтверждение после рестарта.
    for await (const chunk of await secondGraph.stream(
      new Command({ resume: { approved: true } }),
      config,
    )) {
      void chunk;
    }

    const finalState = await secondGraph.getState(config);

    expect(finalState.values).toMatchObject({
      query: 'send invoice',
      approved: true,
      outcome: 'executed',
    });
    expect(finalState.next).toEqual([]);
  });

  it('сохраняет отказ после рестарта отдельным решением', async () => {
    const store = createFakeCheckpointPrisma();
    const config = threadConfig();

    const firstGraph = buildApprovalGraph(createSaver(store));
    await firstGraph.invoke({ query: 'delete files' }, config);

    const secondGraph = buildApprovalGraph(createSaver(store));
    const restored = await secondGraph.getState(config);
    expect(restored.next).toEqual(['approval']);

    await secondGraph.invoke(new Command({ resume: { approved: false } }), config);

    const finalState = await secondGraph.getState(config);
    expect(finalState.values).toMatchObject({
      query: 'delete files',
      approved: false,
      outcome: 'rejected',
    });
  });
});
