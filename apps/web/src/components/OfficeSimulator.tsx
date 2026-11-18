import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  findLandingTrack,
  LANDING_TRACKS,
  type TrackId,
} from '../lib/landing-tracks';
import {
  getAgentStatus,
  getStepStatus,
  SIMULATOR_SCENARIOS,
  type SimulationPhase,
  type SimulatorStatus,
} from '../lib/office-simulator';

/** Пауза между шагами: достаточно, чтобы увидеть смену статусов. */
const STEP_DELAY_MS = 1_100;

const STATUS_CLASSES: Record<SimulatorStatus, string> = {
  idle: 'border border-outline-variant bg-surface-container-high text-on-surface-variant',
  working: 'bg-primary-container text-on-primary-container',
  waiting_approval: 'bg-warning-container text-on-warning-container',
  done: 'bg-success/15 text-success',
};

const STATUS_DOTS: Record<SimulatorStatus, string> = {
  idle: 'bg-on-surface-variant/50',
  working: 'bg-primary',
  waiting_approval: 'bg-warning',
  done: 'bg-success',
};

const PRIMARY_BUTTON_CLASSES =
  'inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-5 py-3 text-sm font-semibold text-on-primary shadow-lg shadow-primary/25 transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-70';

const SECONDARY_BUTTON_CLASSES =
  'inline-flex items-center justify-center gap-2 rounded-xl border border-outline bg-surface px-4 py-2.5 text-sm font-semibold text-on-surface transition hover:border-primary/40 hover:bg-surface-container-high focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';

const STEP_NUMBER_CLASSES: Record<SimulatorStatus, string> = {
  idle: 'bg-surface-container-high text-on-surface-variant',
  working: 'bg-primary text-on-primary',
  waiting_approval: 'bg-warning text-on-warning',
  done: 'bg-success/20 text-success',
};

export interface OfficeSimulatorProps {
  /** Ссылка в приложение: статический лендинг ведёт на `VITE_APP_URL`. */
  officeHref: string;
}

/**
 * Превью AI-Офиса для 12 треков A–L (WEB-24.6).
 *
 * Клиентская state machine: трек → шаги сценария → пауза на HITL → результат.
 * Никаких запросов к API, таймеры очищаются при смене трека и размонтировании,
 * поэтому блок безопасен на статическом хостинге и не тянет данные
 * пользователя.
 */
export function OfficeSimulator({ officeHref }: OfficeSimulatorProps) {
  const { t } = useTranslation();
  const [trackId, setTrackId] = useState<TrackId>(LANDING_TRACKS[0].id);
  const track = findLandingTrack(trackId) ?? LANDING_TRACKS[0];
  const scenario = SIMULATOR_SCENARIOS[trackId];
  const [phase, setPhase] = useState<SimulationPhase>('idle');
  const [stepIndex, setStepIndex] = useState(0);

  useEffect(() => {
    if (phase !== 'running') {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      const nextIndex = stepIndex + 1;

      if (nextIndex >= scenario.steps.length) {
        setPhase('done');

        return;
      }

      setStepIndex(nextIndex);

      if (scenario.steps[nextIndex].requiresApproval) {
        setPhase('awaiting_approval');
      }
    }, STEP_DELAY_MS);

    return () => window.clearTimeout(timeoutId);
  }, [phase, stepIndex, scenario]);

  function selectTrack(nextTrackId: TrackId): void {
    setTrackId(nextTrackId);
    setPhase('idle');
    setStepIndex(0);
  }

  function startSimulation(): void {
    setStepIndex(0);
    setPhase(
      scenario.steps[0].requiresApproval ? 'awaiting_approval' : 'running',
    );
  }

  function resetSimulation(): void {
    setPhase('idle');
    setStepIndex(0);
  }

  function approveStep(): void {
    // Пауза снята: эффект продолжит сценарий со следующего шага.
    setPhase('running');
  }

  const prefix = `landing.tracks.items.${track.id}`;
  const currentStep =
    scenario.steps[Math.min(stepIndex, scenario.steps.length - 1)];
  const currentStepLabel = t(`${prefix}.steps.${currentStep.stepKey}`);
  const summary =
    phase === 'idle'
      ? t('landing.simulator.idleHint')
      : phase === 'done'
        ? t('landing.simulator.doneTitle')
        : phase === 'awaiting_approval'
          ? t('landing.simulator.approvalStep', { step: currentStepLabel })
          : t('landing.simulator.currentStep', {
              index: stepIndex + 1,
              total: scenario.steps.length,
              step: currentStepLabel,
            });

  return (
    <section
      id="simulator"
      aria-labelledby="landing-simulator-title"
      className="relative scroll-mt-24 border-y border-outline-variant/70 bg-surface-container/40"
    >
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 lg:py-24">
        <div className="max-w-2xl">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">
            {t('landing.simulator.eyebrow')}
          </p>
          <h2
            id="landing-simulator-title"
            className="mt-3 text-balance font-display text-3xl font-bold tracking-tight text-on-surface sm:text-4xl"
          >
            {t('landing.simulator.title')}
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-on-surface-variant sm:text-base">
            {t('landing.simulator.description')}
          </p>
        </div>

        <div
          role="group"
          aria-label={t('landing.simulator.trackLabel')}
          className="mt-8 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4"
        >
          {LANDING_TRACKS.map((item) => {
            const isActive = item.id === trackId;

            return (
              <button
                key={item.id}
                type="button"
                aria-pressed={isActive}
                onClick={() => selectTrack(item.id)}
                className={`flex items-center gap-2 rounded-xl border px-3 py-2.5 text-left text-xs font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary ${
                  isActive
                    ? 'border-primary/50 bg-primary-container text-on-primary-container shadow-sm'
                    : 'border-outline-variant bg-surface text-on-surface hover:border-primary/40 hover:bg-surface-container-high'
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`inline-grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-bold ${
                    isActive
                      ? 'bg-primary text-on-primary'
                      : 'bg-surface-container-high text-on-surface-variant'
                  }`}
                >
                  {item.letter}
                </span>
                <span aria-hidden="true" className="shrink-0">
                  {item.icon}
                </span>
                <span className="min-w-0 truncate">
                  {t(`landing.tracks.items.${item.id}.name`)}
                </span>
              </button>
            );
          })}
        </div>

        <div className="mt-6 rounded-3xl border border-outline-variant bg-surface p-5 shadow-xl shadow-primary/5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-4 border-b border-outline-variant pb-5">
            <div className="flex min-w-0 items-start gap-3">
              <span
                aria-hidden="true"
                className="grid size-11 shrink-0 place-items-center rounded-xl bg-primary-container text-xl text-on-primary-container"
              >
                {track.icon}
              </span>
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-primary">
                  {t('landing.tracks.details.letter', { letter: track.letter })}
                </p>
                <p className="mt-1 font-display text-xl font-bold text-on-surface">
                  {t(`${prefix}.name`)}
                </p>
                <p className="mt-1 max-w-xl text-sm leading-relaxed text-on-surface-variant">
                  {t(`${prefix}.description`)}
                </p>
              </div>
            </div>
          </div>

          <div className="mt-6 grid gap-6 lg:grid-cols-[1.05fr_0.95fr]">
            <div>
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-on-surface-variant">
                {t('landing.simulator.agentsLabel')}
              </h3>
              <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                {track.agentKeys.map((agentKey) => {
                  const status = getAgentStatus(
                    scenario,
                    agentKey,
                    stepIndex,
                    phase,
                  );
                  const agentPrefix = `${prefix}.agents.${agentKey}`;
                  const name = t(`${agentPrefix}.name`);
                  const role = t(`${agentPrefix}.role`, { defaultValue: '' });

                  return (
                    <li
                      key={agentKey}
                      className="flex items-center gap-3 rounded-xl border border-outline-variant bg-surface-container px-3 py-2.5"
                    >
                      <span
                        aria-hidden="true"
                        className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary-container text-sm font-bold text-on-primary-container"
                      >
                        {name.slice(0, 1)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-on-surface">
                          {name}
                        </p>
                        {role !== '' && (
                          <p className="truncate text-xs text-on-surface-variant">
                            {role}
                          </p>
                        )}
                      </div>
                      <span
                        className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-semibold ${STATUS_CLASSES[status]}`}
                      >
                        <span
                          aria-hidden="true"
                          className={`size-1.5 rounded-full ${STATUS_DOTS[status]}`}
                        />
                        {t(`landing.simulator.status.${status}`)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>

            <div>
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-on-surface-variant">
                {t('landing.simulator.scenarioLabel')}
              </h3>
              <p
                role="status"
                aria-live="polite"
                className="mt-3 rounded-xl bg-surface-container px-3 py-2.5 text-sm font-medium text-on-surface"
              >
                {summary}
              </p>
              <ol className="mt-3 space-y-2">
                {scenario.steps.map((step, index) => {
                  const status = getStepStatus(step, index, stepIndex, phase);
                  const agentName = t(`${prefix}.agents.${step.agentKey}.name`);

                  return (
                    <li
                      key={`${step.stepKey}-${index}`}
                      className={`flex items-start gap-3 rounded-xl border px-3 py-2.5 ${
                        step.requiresApproval
                          ? 'border-warning/40 bg-warning-container/30'
                          : 'border-outline-variant bg-surface-container'
                      }`}
                    >
                      <span
                        aria-hidden="true"
                        className={`grid size-6 shrink-0 place-items-center rounded-full text-[11px] font-bold ${STEP_NUMBER_CLASSES[status]}`}
                      >
                        {index + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm leading-relaxed text-on-surface">
                          {t(`${prefix}.steps.${step.stepKey}`)}
                        </p>
                        <p className="mt-1 text-[11px] text-on-surface-variant">
                          {agentName}
                          {step.requiresApproval ? ' · HITL' : ''}
                        </p>
                      </div>
                      <span
                        className={`inline-flex shrink-0 items-center rounded-full px-2 py-1 text-[11px] font-semibold ${STATUS_CLASSES[status]}`}
                      >
                        {t(`landing.simulator.status.${status}`)}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            {phase === 'idle' && (
              <button
                type="button"
                onClick={startSimulation}
                className={PRIMARY_BUTTON_CLASSES}
              >
                <span aria-hidden="true">▶</span>
                {t('landing.simulator.start')}
              </button>
            )}
            {phase === 'running' && (
              <button
                type="button"
                disabled
                aria-busy="true"
                className={PRIMARY_BUTTON_CLASSES}
              >
                {t('landing.simulator.running')}
              </button>
            )}
            {phase !== 'idle' && phase !== 'awaiting_approval' && (
              <button
                type="button"
                onClick={resetSimulation}
                className={SECONDARY_BUTTON_CLASSES}
              >
                {t('landing.simulator.reset')}
              </button>
            )}
          </div>

          {phase === 'awaiting_approval' && (
            <div className="mt-4 rounded-2xl border border-warning/40 bg-warning-container/40 p-4">
              <p
                role="status"
                className="text-sm font-semibold text-on-warning-container"
              >
                <span aria-hidden="true">✋ </span>
                {t('landing.simulator.approvalHint')}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={approveStep}
                  className={PRIMARY_BUTTON_CLASSES}
                >
                  {t('landing.simulator.approve')}
                </button>
                <button
                  type="button"
                  onClick={resetSimulation}
                  className={SECONDARY_BUTTON_CLASSES}
                >
                  {t('landing.simulator.reset')}
                </button>
              </div>
            </div>
          )}

          {phase === 'done' && (
            <div className="mt-5 rounded-2xl border border-success/30 bg-success/5 p-4 sm:p-5">
              <p className="text-sm font-semibold text-success">
                <span aria-hidden="true">✅ </span>
                {t('landing.simulator.doneTitle')}
              </p>
              <p className="mt-2 text-sm leading-relaxed text-on-surface">
                {t(scenario.resultKey)}
              </p>
              <p className="mt-2 text-xs leading-relaxed text-on-surface-variant">
                {t('landing.simulator.doneHint')}
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <a href={officeHref} className={PRIMARY_BUTTON_CLASSES}>
                  {t('landing.simulator.openOffice')}
                </a>
                <button
                  type="button"
                  onClick={startSimulation}
                  className={SECONDARY_BUTTON_CLASSES}
                >
                  {t('landing.simulator.start')}
                </button>
              </div>
            </div>
          )}

          <p className="mt-5 text-[11px] leading-relaxed text-on-surface-variant">
            {t('landing.simulator.demoNotice')}
          </p>
        </div>
      </div>
    </section>
  );
}
