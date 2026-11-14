import { describe, expect, it } from 'vitest';
import { parseResumeCandidate, parseResumeJson } from './resume';

describe('parseResumeCandidate', () => {
  it('нормализует строковые и объектные навыки', () => {
    const candidate = parseResumeCandidate({
      name: 'Анна Петрова',
      title: 'Senior Frontend',
      score: 87,
      verdict: 'Сильный кандидат',
      skills: ['React', { name: 'TypeScript', years: 6, level: 90 }],
      experience: [
        {
          company: 'Яндекс',
          position: 'Frontend Lead',
          period: '2021—2025',
          description: 'Платформа объявлений',
          skills: ['React'],
        },
      ],
      education: [{ institution: 'МГТУ', degree: 'ПМ' }],
    });

    expect(candidate).not.toBeNull();
    expect(candidate?.skills).toEqual([
      { name: 'React', level: null, years: null },
      { name: 'TypeScript', level: 90, years: 6 },
    ]);
    expect(candidate?.experience[0]).toEqual({
      company: 'Яндекс',
      position: 'Frontend Lead',
      period: '2021—2025',
      description: 'Платформа объявлений',
      skills: ['React'],
    });
    expect(candidate?.education[0]?.institution).toBe('МГТУ');
  });

  it('разворачивает обёртку candidate/resume/data', () => {
    expect(
      parseResumeCandidate({ candidate: { skills: ['Go'] } })?.skills[0]?.name,
    ).toBe('Go');
    expect(
      parseResumeCandidate({ resume: { skills: ['Rust'] } })?.skills[0]?.name,
    ).toBe('Rust');
    expect(
      parseResumeCandidate({ data: { skills: ['SQL'] } })?.skills[0]?.name,
    ).toBe('SQL');
  });

  it('принимает результат только с вердиктом', () => {
    expect(
      parseResumeCandidate({ name: 'Пётр', verdict: 'Не подходит' }),
    ).toMatchObject({ name: 'Пётр', verdict: 'Не подходит' });
  });

  it('обычный JSON не считает резюме', () => {
    expect(parseResumeCandidate({ total: 2, items: [] })).toBeNull();
    expect(parseResumeCandidate({ name: 'Отчёт' })).toBeNull();
    expect(parseResumeCandidate(null)).toBeNull();
    expect(parseResumeCandidate('строка')).toBeNull();
  });

  it('отклоняет невалидные навыки и уровни вне 0–100', () => {
    expect(parseResumeCandidate({ skills: [42] })).toBeNull();
    expect(
      parseResumeCandidate({ skills: [{ name: 'Go', level: 150 }] }),
    ).toBeNull();
  });
});

describe('parseResumeJson', () => {
  it('разбирает JSON-строку и игнорирует мусор', () => {
    expect(parseResumeJson('{"skills":["Go"]}')?.skills[0]?.name).toBe('Go');
    expect(parseResumeJson('не json')).toBeNull();
    expect(parseResumeJson('[1,2,3]')).toBeNull();
  });
});
