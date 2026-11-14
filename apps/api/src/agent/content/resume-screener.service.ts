import { Injectable } from '@nestjs/common';
import {
  ScreenResumeToolSchema,
  type ScreenResumeToolArgs,
} from './content.schemas.js';
import { canonicalSkill, parseResume } from './resume-parser.js';

/**
 * Скрининг резюме: разбор реального текста и сопоставление с требованиями.
 *
 * Оценка появляется только при переданных требованиях и всегда объяснима:
 * 70 % веса — покрытие обязательных навыков, 30 % — выполнение минимального
 * опыта. Веса нормируются на те компоненты, которые заданы, поэтому «нет
 * требований» даёт `score: null`, а не выдуманные 85/100.
 */

/** Сопоставление резюме с требованиями. */
export interface ResumeMatch {
  readonly requiredSkills: readonly string[];
  readonly matchedSkills: readonly string[];
  readonly missingSkills: readonly string[];
  /** Доля найденных обязательных навыков (0–1). */
  readonly coverage: number;
  readonly minExperienceYears: number | null;
  readonly experienceMet: boolean | null;
}

/** Вес навыков в оценке. */
const SKILL_WEIGHT = 70;
/** Вес опыта в оценке. */
const EXPERIENCE_WEIGHT = 30;

@Injectable()
export class ResumeScreenerService {
  /**
   * Разбирает резюме и возвращает JSON-результат инструмента.
   *
   * Верхний уровень ответа — контракт карточек UI
   * (`apps/web/src/lib/resume.ts`): `name`, `title`, `summary`, `score`,
   * `verdict`, `skills`, `experience[{company,position,period}]`,
   * `education[{institution,degree}]`. Детали разбора лежат в `analysis`,
   * чтобы не ломать карточки: ключей `candidate`/`resume`/`data` на верхнем
   * уровне нет, иначе UI принял бы их за обёртку.
   */
  screen(rawArgs: unknown): string {
    const args = ScreenResumeToolSchema.parse(rawArgs) as ScreenResumeToolArgs;
    const parsed = parseResume(args.resumeText);
    const match = buildMatch(parsed, args.requirements);
    const score = computeScore(parsed.experience.years, match);
    const warnings = [...parsed.warnings];

    if (match === null) {
      warnings.push(
        'требования вакансии не переданы: score не рассчитан (сопоставлять не с чем)',
      );
    }

    const skills = [
      ...new Set([...parsed.skills, ...parsed.skillsFromSections]),
    ];

    return JSON.stringify({
      tool: 'resume-screener',
      name: parsed.contact.name,
      title: args.jobTitle ?? null,
      summary: parsed.summary,
      score,
      verdict: verdictFor(score),
      skills,
      experience: parsed.experience.positions
        .filter(
          (position) =>
            (position.company ?? position.title) !== null,
        )
        .map((position) => ({
          company: position.company ?? position.title ?? 'Не указано',
          position: position.title,
          period: `${position.from} — ${position.to}`,
          ...(position.months === null
            ? {}
            : { description: `${position.months} мес.` }),
        })),
      education: parsed.education.institutions.map((institution) => ({
        institution,
        degree: parsed.education.level,
      })),
      languages: parsed.languages,
      match,
      scoreFormula:
        'score = round(100 * (70 * coverage + 30 * min(years/minYears, 1)) / (70 + 30)); компоненты без требований не учитываются',
      analysis: {
        contact: parsed.contact,
        skillsFromSections: parsed.skillsFromSections,
        totalMonths: parsed.experience.totalMonths,
        years: parsed.experience.years,
        current: parsed.experience.current,
        educationLevel: parsed.education.level,
      },
      warnings,
    });
  }
}

/**
 * Ярлык вердикта для карточек UI.
 *
 * Это подпись к `score`, а не отдельная оценка: пороги 80/60 и ничего больше.
 *
 * @returns `null`, если требований не было и оценки нет
 */
export function verdictFor(score: number | null): string | null {
  if (score === null) {
    return null;
  }

  if (score >= 80) {
    return 'Высокое соответствие требованиям';
  }

  if (score >= 60) {
    return 'Среднее соответствие требованиям';
  }

  return 'Низкое соответствие требованиям';
}

/**
 * Сопоставляет разобранные навыки с требованиями.
 *
 * @returns `null`, если требования не заданы
 */
export function buildMatch(
  resume: {
    readonly skills: readonly string[];
    readonly skillsFromSections: readonly string[];
    readonly experience: { readonly years: number };
  },
  requirements:
    | {
        readonly skills?: readonly string[];
        readonly minExperienceYears?: number;
      }
    | undefined,
): ResumeMatch | null {
  if (requirements === undefined) {
    return null;
  }

  const required = (requirements.skills ?? [])
    .map((skill) => canonicalSkill(skill) ?? skill.trim())
    .filter((skill) => skill !== '');
  const resumeSkills = new Set(
    [...resume.skills, ...resume.skillsFromSections]
      .map((skill) => canonicalSkill(skill) ?? skill.trim().toLowerCase())
      .filter((skill) => skill !== ''),
  );
  const matched = required.filter((skill) =>
    resumeSkills.has(canonicalSkill(skill) ?? skill.toLowerCase()),
  );
  const missing = required.filter((skill) => !matched.includes(skill));
  const coverage = required.length === 0 ? 1 : matched.length / required.length;
  const minExperienceYears = requirements.minExperienceYears ?? null;

  return {
    requiredSkills: required,
    matchedSkills: matched,
    missingSkills: missing,
    coverage,
    minExperienceYears,
    experienceMet:
      minExperienceYears === null
        ? null
        : resume.experience.years >= minExperienceYears,
  };
}

/**
 * Считает оценку 0–100 по известной формуле.
 *
 * @returns `null`, если требований нет (оценивать нечего)
 */
export function computeScore(
  experienceYears: number,
  match: ResumeMatch | null,
): number | null {
  if (match === null) {
    return null;
  }

  const hasSkills = match.requiredSkills.length > 0;
  const hasExperience = match.minExperienceYears !== null;
  const totalWeight =
    (hasSkills ? SKILL_WEIGHT : 0) + (hasExperience ? EXPERIENCE_WEIGHT : 0);

  if (totalWeight === 0) {
    return null;
  }

  const skillPart = hasSkills ? SKILL_WEIGHT * match.coverage : 0;
  const experiencePart =
    hasExperience && match.minExperienceYears !== null
      ? EXPERIENCE_WEIGHT *
        (match.minExperienceYears === 0
          ? 1
          : Math.min(
              1,
              experienceYears / Math.max(match.minExperienceYears, 1),
            ))
      : 0;

  return Math.round(((skillPart + experiencePart) / totalWeight) * 100);
}
