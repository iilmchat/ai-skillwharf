import { LANDING_TRACK_IDS, type TrackId } from './landing-tracks';

/**
 * Данные интерактивного превью AI-Офиса (WEB-24.6).
 *
 * Симулятор полностью клиентский: шаги — это ключи уже существующих сценариев
 * лендинга (`landing.tracks.items.<track>.steps.*`), агенты — ключи карточек
 * трека. Здесь хранится только то, чего нет в карточках: кто выполняет шаг,
 * на каком шаге сценарий останавливается ради HITL и где лежит итоговый
 * результат. Никаких сетевых вызовов нет, поэтому блок работает на статическом
 * хостинге даже при выключенном API.
 */

/** Фазы клиентского сценария. */
export type SimulationPhase = 'idle' | 'running' | 'awaiting_approval' | 'done';

/** Статус агента или шага. */
export type SimulatorStatus = 'idle' | 'working' | 'waiting_approval' | 'done';

export interface SimulatorStep {
  /** Ключ шага в локали: `landing.tracks.items.<track>.steps.*`. */
  stepKey: string;
  /** Агент, который выполняет шаг (ключ из `track.agentKeys`). */
  agentKey: string;
  /** Шаг останавливает сценарий до одобрения человеком (HITL). */
  requiresApproval: boolean;
}

export interface SimulatorScenario {
  trackId: TrackId;
  steps: readonly SimulatorStep[];
  /** Ключ итогового результата: `landing.simulator.results.<track>`. */
  resultKey: string;
}

function step(
  stepKey: string,
  agentKey: string,
  requiresApproval = false,
): SimulatorStep {
  return { stepKey, agentKey, requiresApproval };
}

function scenario(
  trackId: TrackId,
  steps: readonly SimulatorStep[],
): SimulatorScenario {
  return {
    trackId,
    steps,
    resultKey: `landing.simulator.results.${trackId}`,
  };
}

/**
 * Сценарий каждого из 12 треков A–L.
 *
 * `Record<TrackId, …>` гарантирует на уровне типов, что новый трек нельзя
 * добавить без демо-сценария. HITL стоит на шаге, где действие необратимо
 * (возврат, откат, публикация, заказ поставщику) или требует решения человека
 * по демо-сценарию из `docs/ecosystem/USE-CASES-GUIDE.md`.
 */
export const SIMULATOR_SCENARIOS: Readonly<Record<TrackId, SimulatorScenario>> =
  {
    pvz: scenario('pvz', [
      step('s1', 'reporting'),
      step('s2', 'operator'),
      step('s3', 'returns', true),
      step('s4', 'reporting'),
    ]),
    dev: scenario('dev', [
      step('s1', 'oncall'),
      step('s2', 'oncall'),
      step('s3', 'reviewer', true),
      step('s4', 'documenter'),
    ]),
    ecommerce: scenario('ecommerce', [
      step('s1', 'analyst'),
      step('s2', 'support'),
      step('s3', 'catalog', true),
      step('s4', 'ads'),
    ]),
    marketing: scenario('marketing', [
      step('s1', 'dispatcher'),
      step('s2', 'seo', true),
      step('s3', 'copywriter'),
      step('s4', 'design'),
    ]),
    education: scenario('education', [
      step('s1', 'methodist'),
      step('s2', 'tutor'),
      step('s3', 'checker', true),
      step('s4', 'dispatcher'),
    ]),
    content: scenario('content', [
      step('s1', 'trend'),
      step('s2', 'copywriter'),
      step('s3', 'factchecker'),
      step('s4', 'editor', true),
      step('s5', 'editor'),
    ]),
    hr: scenario('hr', [
      step('s1', 'screener'),
      step('s2', 'screener'),
      step('s3', 'interviewer'),
      step('s4', 'recruiter', true),
    ]),
    documents: scenario('documents', [
      step('s1', 'secretary'),
      step('s2', 'lawyer'),
      step('s3', 'finance'),
      step('s4', 'director', true),
    ]),
    ocr: scenario('ocr', [
      step('s1', 'pdf'),
      step('s2', 'ocr'),
      step('s3', 'analyzer', true),
      step('s4', 'analyzer'),
    ]),
    finance: scenario('finance', [
      step('s1', 'unit'),
      step('s2', 'leak'),
      step('s3', 'fraud', true),
      step('s4', 'unit'),
    ]),
    wholesale: scenario('wholesale', [
      step('s1', 'operations'),
      step('s2', 'credit'),
      step('s3', 'sales', true),
      step('s4', 'margin'),
    ]),
    production: scenario('production', [
      step('s1', 'configurator'),
      step('s2', 'procurement'),
      step('s3', 'procurement', true),
      step('s4', 'technologist'),
      step('s5', 'quality'),
    ]),
  };

/** Сценарии в порядке треков A–L — для тестов и переключателя. */
export const SIMULATOR_SCENARIO_LIST: readonly SimulatorScenario[] =
  LANDING_TRACK_IDS.map((trackId) => SIMULATOR_SCENARIOS[trackId]);

/** Сценарий трека: `Record` покрывает все `TrackId`, поэтому `undefined` нет. */
export function findSimulatorScenario(trackId: TrackId): SimulatorScenario {
  return SIMULATOR_SCENARIOS[trackId];
}

/** Статус агента на текущем шаге сценария. */
export function getAgentStatus(
  scenario: SimulatorScenario,
  agentKey: string,
  stepIndex: number,
  phase: SimulationPhase,
): SimulatorStatus {
  if (phase === 'idle') {
    return 'idle';
  }

  const ownIndexes = scenario.steps
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.agentKey === agentKey)
    .map(({ index }) => index);

  if (ownIndexes.length === 0) {
    return 'idle';
  }

  if (phase === 'done') {
    return 'done';
  }

  const currentIndex = ownIndexes.find((index) => index === stepIndex);

  if (currentIndex !== undefined) {
    const isApproval = scenario.steps[currentIndex].requiresApproval;

    return isApproval && phase === 'awaiting_approval'
      ? 'waiting_approval'
      : 'working';
  }

  return ownIndexes.some((index) => index < stepIndex) ? 'done' : 'idle';
}

/** Статус шага сценария: выполнено / выполняется / ждёт HITL / ожидает. */
export function getStepStatus(
  step: SimulatorStep,
  index: number,
  stepIndex: number,
  phase: SimulationPhase,
): SimulatorStatus {
  if (phase === 'idle') {
    return 'idle';
  }

  if (phase === 'done' || index < stepIndex) {
    return 'done';
  }

  if (index > stepIndex) {
    return 'idle';
  }

  if (step.requiresApproval) {
    return phase === 'awaiting_approval' ? 'waiting_approval' : 'done';
  }

  return 'working';
}
