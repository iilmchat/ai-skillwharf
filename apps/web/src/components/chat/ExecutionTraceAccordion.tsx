import { useId, useMemo, useState } from 'react';
import type { ExecutionStep, ExecutionStepStatus } from '../../lib/artifacts';

/** Сводка плашки: пересчитывается из шагов, а не берётся с сервера. */
export interface ExecutionTraceStats {
  count: number;
  totalDurationMs: number;
  totalCostRub: number;
  /** Секунды с одним знаком после точки — для подстановки в i18n. */
  seconds: string;
  /** Стоимость с двумя знаками — для подстановки в i18n. */
  cost: string;
}

function getExecutionTraceStats(
  steps: readonly ExecutionStep[],
): ExecutionTraceStats {
  const totalDurationMs = steps.reduce(
    (total, step) => total + step.durationMs,
    0,
  );
  const totalCostRub = steps.reduce(
    (total, step) => total + (step.costRub ?? 0),
    0,
  );

  return {
    count: steps.length,
    totalDurationMs,
    totalCostRub,
    seconds: (totalDurationMs / 1000).toFixed(1),
    cost: totalCostRub.toFixed(2),
  };
}

export interface ExecutionTraceLabels {
  summary: (stats: ExecutionTraceStats) => string;
  expand: string;
  collapse: string;
  step: (stepIndex: number) => string;
  tool: (toolName: string) => string;
  duration: (milliseconds: number) => string;
  cost: (rubles: number) => string;
  noCost: string;
  status: Record<ExecutionStepStatus, string>;
}

const STATUS_ICON: Record<ExecutionStepStatus, string> = {
  completed: '✓',
  failed: '✕',
  hitl_paused: '⏸',
};

const STATUS_CLASSES: Record<ExecutionStepStatus, string> = {
  completed: 'bg-tertiary-container text-on-tertiary-container',
  failed: 'bg-error-container text-on-error-container',
  hitl_paused: 'bg-primary-container text-on-primary-container',
};

/**
 * Сворачиваемый инспектор Execution DAG (UX-37.3).
 *
 * Показывается только когда API прислало непустой `executionTrace`; порядок
 * шагов восстанавливается по `stepIndex`, чтобы таймлайн не зависел от
 * порядка элементов в ответе.
 */
export function ExecutionTraceAccordion({
  steps,
  labels,
}: {
  steps: readonly ExecutionStep[];
  labels: ExecutionTraceLabels;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const contentId = useId();
  const orderedSteps = useMemo(
    () => [...steps].sort((left, right) => left.stepIndex - right.stepIndex),
    [steps],
  );
  const stats = useMemo(() => getExecutionTraceStats(steps), [steps]);

  return (
    <section className="mb-2 overflow-hidden rounded-xl border border-outline-variant bg-surface-container/60">
      <button
        type="button"
        onClick={() => setIsExpanded((value) => !value)}
        aria-expanded={isExpanded}
        aria-controls={contentId}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-on-surface-variant transition hover:bg-surface-container-high focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          fill="currentColor"
          className={`size-3 shrink-0 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
        >
          <path d="M7 4.5a1 1 0 0 1 1.5-.87l7 5.5a1 1 0 0 1 0 1.74l-7 5.5A1 1 0 0 1 7 15.5v-11Z" />
        </svg>
        <span>{labels.summary(stats)}</span>
        <span className="sr-only">
          {isExpanded ? labels.collapse : labels.expand}
        </span>
      </button>

      {isExpanded && (
        <ol id={contentId} className="border-t border-outline-variant px-3 py-3">
          {orderedSteps.map((step) => (
            <li
              key={step.stepIndex}
              className="relative pb-3 pl-6 last:pb-0 before:absolute before:left-[5px] before:top-4 before:h-full before:w-px before:bg-outline-variant last:before:hidden"
            >
              <span
                aria-hidden="true"
                className={`absolute left-0 top-1.5 grid size-2.5 place-items-center rounded-full text-[8px] ${STATUS_CLASSES[step.status]}`}
              >
                {STATUS_ICON[step.status]}
              </span>
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="text-xs font-semibold text-on-surface">
                  {labels.step(step.stepIndex)} · {step.name}
                </span>
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${STATUS_CLASSES[step.status]}`}
                >
                  {labels.status[step.status]}
                </span>
              </div>
              <div className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-on-surface-variant">
                {step.toolName !== undefined && step.toolName !== '' && (
                  <span>{labels.tool(step.toolName)}</span>
                )}
                <span>{labels.duration(step.durationMs)}</span>
                <span>
                  {step.costRub === undefined
                    ? labels.noCost
                    : labels.cost(step.costRub)}
                </span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
