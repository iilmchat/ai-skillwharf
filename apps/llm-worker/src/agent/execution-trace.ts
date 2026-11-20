import type { ExecutionStep } from '../contracts.js';

type RawStep = Omit<ExecutionStep, 'stepIndex'>;

/**
 * Хронология шагов графа для инспектора Execution DAG (UX-37.3).
 *
 * Шаги собираются из streaming-обновлений узлов, завершений инструментов
 * и событий HITL/handoff. Все длительности — монотонные, в миллисекундах.
 */
export class ExecutionTraceCollector {
  private readonly raw: RawStep[] = [];
  private lastAt: number;

  constructor(private readonly now: () => number = () => performance.now()) {
    this.lastAt = this.now();
  }

  add(step: RawStep): void {
    this.raw.push(step);
  }

  /** Длительность узла — от предыдущего обновления до текущего. */
  observeNode(node: string): number {
    const current = this.now();
    const durationMs = Math.max(0, Math.round(current - this.lastAt));

    this.lastAt = current;
    this.add({ name: node, durationMs, status: 'completed' });

    return durationMs;
  }

  observeTool(name: string, durationMs: number, failed: boolean): void {
    this.add({
      name: 'tool',
      toolName: name,
      durationMs,
      status: failed ? 'failed' : 'completed',
    });
  }

  observeHandoff(toRole: string): void {
    this.add({
      name: 'handoff',
      toolName: toRole,
      durationMs: 0,
      status: 'completed',
    });
  }

  observeHitl(tools: readonly string[]): void {
    this.add({
      name: 'hitl',
      toolName: tools.join(', '),
      durationMs: 0,
      status: 'hitl_paused',
    });
  }

  steps(): ExecutionStep[] {
    return this.raw.map((step, stepIndex) => ({ stepIndex, ...step }));
  }
}
