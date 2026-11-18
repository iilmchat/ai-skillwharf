import { describe, expect, it } from 'vitest';
import en from '../locales/en.json';
import ru from '../locales/ru.json';
import {
  LANDING_TRACK_IDS,
  LANDING_TRACKS,
  type TrackId,
} from './landing-tracks';
import {
  findSimulatorScenario,
  getAgentStatus,
  getStepStatus,
  SIMULATOR_SCENARIOS,
  SIMULATOR_SCENARIO_LIST,
} from './office-simulator';

interface TrackLocale {
  name: string;
  description: string;
  agents: Record<string, { name: string; role?: string }>;
  steps: Record<string, string>;
}

const ruItems = ru.landing.tracks.items as unknown as Record<
  TrackId,
  TrackLocale
>;
const enItems = en.landing.tracks.items as unknown as Record<
  TrackId,
  TrackLocale
>;
const ruResults = ru.landing.simulator.results as unknown as Record<
  TrackId,
  string
>;
const enResults = en.landing.simulator.results as unknown as Record<
  TrackId,
  string
>;
const TRACK_LETTERS = [
  'A',
  'B',
  'C',
  'D',
  'E',
  'F',
  'G',
  'H',
  'I',
  'J',
  'K',
  'L',
] as const;

describe('данные 12 треков A–L', () => {
  it('содержит все 12 треков в порядке A–L без дублей', () => {
    expect(LANDING_TRACKS).toHaveLength(12);
    expect(LANDING_TRACKS.map((track) => track.letter)).toEqual([
      ...TRACK_LETTERS,
    ]);
    expect(LANDING_TRACKS.map((track) => track.id)).toEqual([
      ...LANDING_TRACK_IDS,
    ]);
    expect(new Set(LANDING_TRACK_IDS).size).toBe(12);
  });

  it('у каждого трека 3–5 агентов и 4–5 шагов сценария', () => {
    for (const track of LANDING_TRACKS) {
      expect(
        track.agentKeys.length,
        `${track.letter}: агенты`,
      ).toBeGreaterThanOrEqual(3);
      expect(
        track.agentKeys.length,
        `${track.letter}: агенты`,
      ).toBeLessThanOrEqual(5);
      expect(
        track.stepKeys.length,
        `${track.letter}: шаги`,
      ).toBeGreaterThanOrEqual(4);
      expect(
        track.stepKeys.length,
        `${track.letter}: шаги`,
      ).toBeLessThanOrEqual(5);
    }
  });

  it('имеет названия, описания, агентов и шаги в RU и EN', () => {
    for (const track of LANDING_TRACKS) {
      for (const [language, items] of [
        ['ru', ruItems],
        ['en', enItems],
      ] as const) {
        const spot = `${language}:${track.id}`;
        const localeTrack = items[track.id];

        expect(localeTrack, spot).toBeDefined();
        expect(localeTrack.name.length, spot).toBeGreaterThan(0);
        expect(localeTrack.description.length, spot).toBeGreaterThan(0);

        for (const agentKey of track.agentKeys) {
          const agent = localeTrack.agents[agentKey];

          expect(agent, `${spot}:agent:${agentKey}`).toBeDefined();
          expect(
            agent.name.length,
            `${spot}:agent:${agentKey}`,
          ).toBeGreaterThan(0);
        }

        for (const stepKey of track.stepKeys) {
          const step = localeTrack.steps[stepKey];

          expect(step, `${spot}:step:${stepKey}`).toBeDefined();
          expect(step.length, `${spot}:step:${stepKey}`).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe('сценарии превью-симулятора', () => {
  it('покрывает каждый трек ровно одним сценарием', () => {
    expect(SIMULATOR_SCENARIO_LIST).toHaveLength(12);
    expect(SIMULATOR_SCENARIO_LIST.map((entry) => entry.trackId)).toEqual([
      ...LANDING_TRACK_IDS,
    ]);

    for (const trackId of LANDING_TRACK_IDS) {
      expect(findSimulatorScenario(trackId).trackId, trackId).toBe(trackId);
    }
  });

  it('использует шаги и агентов своего трека и одну остановку HITL', () => {
    for (const track of LANDING_TRACKS) {
      const scenario = SIMULATOR_SCENARIOS[track.id];
      const spot = `трек ${track.letter}`;

      expect(
        scenario.steps.map((step) => step.stepKey),
        spot,
      ).toEqual([...track.stepKeys]);

      for (const step of scenario.steps) {
        expect(track.agentKeys, `${spot}:${step.stepKey}`).toContain(
          step.agentKey,
        );
      }

      expect(
        scenario.steps.filter((step) => step.requiresApproval),
        `${spot}: HITL`,
      ).toHaveLength(1);
    }
  });

  it('держит ключи результатов и их тексты в обеих локалях', () => {
    for (const track of LANDING_TRACKS) {
      const scenario = SIMULATOR_SCENARIOS[track.id];
      const spot = `трек ${track.letter}`;

      expect(scenario.resultKey, spot).toBe(
        `landing.simulator.results.${track.id}`,
      );
      expect(ruResults[track.id]?.length ?? 0, `${spot}: ru`).toBeGreaterThan(
        20,
      );
      expect(enResults[track.id]?.length ?? 0, `${spot}: en`).toBeGreaterThan(
        20,
      );
    }
  });
});

describe('getAgentStatus', () => {
  const scenario = SIMULATOR_SCENARIOS.pvz;

  it('до запуска все агенты ожидают', () => {
    expect(getAgentStatus(scenario, 'returns', 0, 'idle')).toBe('idle');
  });

  it('на своём шаге агент работает', () => {
    expect(getAgentStatus(scenario, 'operator', 1, 'running')).toBe('working');
  });

  it('на HITL-шаге агент ждёт одобрения', () => {
    expect(getAgentStatus(scenario, 'returns', 2, 'awaiting_approval')).toBe(
      'waiting_approval',
    );
  });

  it('после завершения и на прошлых шагах агент готов', () => {
    expect(getAgentStatus(scenario, 'operator', 3, 'done')).toBe('done');
    expect(getAgentStatus(scenario, 'operator', 2, 'running')).toBe('done');
  });

  it('агент без шагов в сценарии остаётся в ожидании', () => {
    expect(getAgentStatus(scenario, 'support', 2, 'awaiting_approval')).toBe(
      'idle',
    );
  });
});

describe('getStepStatus', () => {
  const scenario = SIMULATOR_SCENARIOS.pvz;
  const approvalStep = scenario.steps[2];

  it('различает ожидание, работу, HITL и выполнение', () => {
    expect(getStepStatus(scenario.steps[3], 3, 1, 'running')).toBe('idle');
    expect(getStepStatus(scenario.steps[1], 1, 1, 'running')).toBe('working');
    expect(getStepStatus(approvalStep, 2, 2, 'running')).toBe('done');
    expect(getStepStatus(approvalStep, 2, 2, 'awaiting_approval')).toBe(
      'waiting_approval',
    );
    expect(getStepStatus(scenario.steps[0], 0, 2, 'awaiting_approval')).toBe(
      'done',
    );
  });
});
