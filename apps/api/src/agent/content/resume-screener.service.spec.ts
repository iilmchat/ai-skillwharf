import { describe, expect, it } from 'vitest';
import {
  buildMatch,
  computeScore,
  ResumeScreenerService,
} from './resume-screener.service.js';

const RESUME = `Пётр Петров
petrov@example.com, +7 (999) 000-11-22

Опыт работы
ООО «Ромашка» — Backend Developer
01.2020 — 01.2025
Разработка на TypeScript и PostgreSQL.

Навыки
TypeScript, PostgreSQL, Docker, Jira
`;

/** Разбор JSON-ответа инструмента. */
function parse(raw: string): Record<string, unknown> {
  return JSON.parse(raw) as Record<string, unknown>;
}

describe('ResumeScreenerService', () => {
  const service = new ResumeScreenerService();

  it('сопоставляет требования и считает объяснимую оценку', () => {
    const result = parse(
      service.screen({
        resumeText: RESUME,
        jobTitle: 'Backend Developer',
        requirements: {
          skills: ['typescript', 'PostgreSQL', 'Kubernetes'],
          minExperienceYears: 5,
        },
      }),
    );

    expect(result).toMatchObject({
      tool: 'resume-screener',
      name: 'Пётр Петров',
      title: 'Backend Developer',
      score: 77,
      verdict: 'Среднее соответствие требованиям',
      match: {
        requiredSkills: ['TypeScript', 'PostgreSQL', 'Kubernetes'],
        matchedSkills: ['TypeScript', 'PostgreSQL'],
        missingSkills: ['Kubernetes'],
        coverage: 2 / 3,
        minExperienceYears: 5,
        experienceMet: true,
      },
    });
    expect(result.warnings).toEqual([]);
    expect(typeof result.scoreFormula).toBe('string');
    expect(result.analysis).toMatchObject({ totalMonths: 61, years: 5.1 });
  });

  it('отдаёт контракт карточек UI: строки навыков, опыт и образование', () => {
    const result = parse(service.screen({ resumeText: RESUME })) as {
      skills: string[];
      experience: Array<{ company: string; position: string | null; period: string }>;
      education: Array<{ institution: string; degree: string | null }>;
      verdict: string | null;
    };

    expect(result.skills).toEqual(
      expect.arrayContaining(['TypeScript', 'PostgreSQL', 'Docker', 'Jira']),
    );
    expect(result.experience).toEqual([
      expect.objectContaining({
        company: 'ООО «Ромашка»',
        position: 'Backend Developer',
        period: '2020-01 — 2025-01',
      }),
    ]);
    expect(result.education).toEqual([]);
    expect(result.verdict).toBeNull();
  });

  it('без требований не выдумывает score', () => {
    const result = parse(service.screen({ resumeText: RESUME }));

    expect(result.score).toBeNull();
    expect(result.match).toBeNull();
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        'требования вакансии не переданы: score не рассчитан (сопоставлять не с чем)',
      ]),
    );
    expect(result.skills).toEqual(
      expect.arrayContaining(['TypeScript', 'PostgreSQL', 'Docker', 'Jira']),
    );
  });

  it('не проходит минимальный опыт и снижает оценку', () => {
    const result = parse(
      service.screen({
        resumeText: RESUME,
        requirements: { minExperienceYears: 10 },
      }),
    );

    expect(result.match).toMatchObject({ experienceMet: false });
    expect(result.score).toBe(51);
  });

  it('отклоняет аргументы не по схеме', () => {
    expect(() => service.screen({ resumeText: '' })).toThrow();
    expect(() =>
      service.screen({ resumeText: RESUME, extra: true }),
    ).toThrow();
    expect(() =>
      service.screen({ resumeText: RESUME, requirements: { skills: [42] } }),
    ).toThrow();
  });
});

describe('buildMatch / computeScore', () => {
  const resume = {
    skills: ['TypeScript', 'Node.js'],
    skillsFromSections: ['публичные выступления'],
    experience: { years: 3 },
  };

  it('канонизирует навыки обеих сторон', () => {
    const match = buildMatch(resume, { skills: ['typescript', 'nodejs'] });

    expect(match).toMatchObject({
      requiredSkills: ['TypeScript', 'Node.js'],
      matchedSkills: ['TypeScript', 'Node.js'],
      coverage: 1,
      experienceMet: null,
    });
    expect(computeScore(3, match)).toBe(100);
  });

  it('учитывает навыки из раздела без словаря', () => {
    const match = buildMatch(resume, { skills: ['публичные выступления'] });

    expect(match?.matchedSkills).toEqual(['публичные выступления']);
  });

  it('возвращает null без требований и без весов', () => {
    expect(buildMatch(resume, undefined)).toBeNull();
    expect(computeScore(3, null)).toBeNull();

    const emptyMatch = buildMatch(resume, {});
    expect(computeScore(3, emptyMatch)).toBeNull();
  });

  it('не делит на ноль при нулевом минимальном опыте', () => {
    const match = buildMatch(resume, { minExperienceYears: 0 });

    expect(computeScore(0, match)).toBe(100);
  });
});
