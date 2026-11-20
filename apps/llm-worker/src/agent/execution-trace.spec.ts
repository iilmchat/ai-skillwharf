import { describe, expect, it } from 'vitest';
import { executionStepSchema } from '../contracts.js';
import { ExecutionTraceCollector } from './execution-trace.js';

describe('ExecutionTraceCollector (UX-37.3)', () => {
  it('собирает узлы, инструменты, handoff и HITL в хронологию', () => {
    const timestamps = [100, 135, 150, 150];
    const collector = new ExecutionTraceCollector(() => timestamps.shift() ?? 200);

    collector.observeNode('llm');
    collector.observeTool('write_docx', 35, false);
    collector.observeHandoff('drafter');
    collector.observeHitl(['exec']);

    const steps = collector.steps();

    expect(steps.map((step) => step.stepIndex)).toEqual([0, 1, 2, 3]);
    expect(steps[0]).toMatchObject({ name: 'llm', durationMs: 35 });
    expect(steps[1]).toMatchObject({
      name: 'tool',
      toolName: 'write_docx',
      status: 'completed',
    });
    expect(steps[2]).toMatchObject({ name: 'handoff', toolName: 'drafter' });
    expect(steps[3]).toMatchObject({ name: 'hitl', status: 'hitl_paused' });
    steps.forEach((step) => {
      expect(executionStepSchema.safeParse(step).success).toBe(true);
    });
  });

  it('отмечает упавший инструмент статусом failed', () => {
    const collector = new ExecutionTraceCollector(() => 0);

    collector.observeTool('exec', 12, true);

    expect(collector.steps()[0]).toMatchObject({ status: 'failed' });
  });
});
