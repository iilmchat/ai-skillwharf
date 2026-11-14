import { z } from 'zod';

/**
 * Контракт результата `resume-screener`.
 *
 * Агент возвращает JSON-объект, который UI показывает карточками навыков и
 * опыта. Поддерживаются два вида навыка — строка и объект, а также
 * однократная обёртка `{ "candidate": {…} }` / `{ "resume": {…} }`.
 *
 * ```json
 * {
 *   "name": "Анна Петрова",
 *   "title": "Senior Frontend",
 *   "summary": "8 лет в продуктовых командах",
 *   "score": 87,
 *   "verdict": "Сильный кандидат",
 *   "skills": ["React", { "name": "TypeScript", "years": 6 }],
 *   "experience": [
 *     { "company": "Яндекс", "position": "Frontend Lead", "period": "2021—2025" }
 *   ],
 *   "education": [{ "institution": "МГТУ", "degree": "Прикладная математика" }]
 * }
 * ```
 *
 * Лишние поля агента игнорируются: карточки строятся только по известным.
 */

export const resumeSkillSchema = z.union([
  z.string().min(1),
  z.object({
    name: z.string().min(1),
    /** Самооценка/уровень владения 0–100, если агент его вернул. */
    level: z.number().min(0).max(100).optional(),
    years: z.number().min(0).optional(),
  }),
]);

export const resumeExperienceSchema = z.object({
  company: z.string().min(1),
  position: z.string().min(1).optional(),
  period: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  skills: z.array(z.string().min(1)).optional(),
});

export const resumeEducationSchema = z.object({
  institution: z.string().min(1),
  degree: z.string().min(1).optional(),
  period: z.string().min(1).optional(),
});

export const resumeCandidateSchema = z.object({
  name: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  summary: z.string().min(1).optional(),
  /** Итоговый скор скрининга 0–100. */
  score: z.number().min(0).max(100).optional(),
  verdict: z.string().min(1).optional(),
  skills: z.array(resumeSkillSchema).optional().default([]),
  experience: z.array(resumeExperienceSchema).optional().default([]),
  education: z.array(resumeEducationSchema).optional().default([]),
});

export interface ResumeSkill {
  name: string;
  level: number | null;
  years: number | null;
}

export interface ResumeExperience {
  company: string;
  position: string | null;
  period: string | null;
  description: string | null;
  skills: string[];
}

export interface ResumeEducation {
  institution: string;
  degree: string | null;
  period: string | null;
}

/** Нормализованный кандидат: карточки не работают с сырым ответом агента. */
export interface ResumeCandidate {
  name: string | null;
  title: string | null;
  summary: string | null;
  score: number | null;
  verdict: string | null;
  skills: ResumeSkill[];
  experience: ResumeExperience[];
  education: ResumeEducation[];
}

type ParsedResume = z.infer<typeof resumeCandidateSchema>;
type ParsedSkill = z.infer<typeof resumeSkillSchema>;
type ParsedExperience = z.infer<typeof resumeExperienceSchema>;
type ParsedEducation = z.infer<typeof resumeEducationSchema>;

function normalizeSkill(skill: ParsedSkill): ResumeSkill {
  if (typeof skill === 'string') {
    return { name: skill, level: null, years: null };
  }

  return {
    name: skill.name,
    level: skill.level ?? null,
    years: skill.years ?? null,
  };
}

function normalizeExperience(item: ParsedExperience): ResumeExperience {
  return {
    company: item.company,
    position: item.position ?? null,
    period: item.period ?? null,
    description: item.description ?? null,
    skills: item.skills ?? [],
  };
}

function normalizeEducation(item: ParsedEducation): ResumeEducation {
  return {
    institution: item.institution,
    degree: item.degree ?? null,
    period: item.period ?? null,
  };
}

function normalizeCandidate(parsed: ParsedResume): ResumeCandidate {
  return {
    name: parsed.name ?? null,
    title: parsed.title ?? null,
    summary: parsed.summary ?? null,
    score: parsed.score ?? null,
    verdict: parsed.verdict ?? null,
    skills: parsed.skills.map(normalizeSkill),
    experience: parsed.experience.map(normalizeExperience),
    education: parsed.education.map(normalizeEducation),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Агент может обернуть резюме в `candidate`/`resume`/`data`. */
function unwrapResumePayload(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }

  for (const key of ['candidate', 'resume', 'data']) {
    const nested = value[key];

    if (isRecord(nested)) {
      return nested;
    }
  }

  return value;
}

/**
 * Разбирает ответ агента в нормализованного кандидата.
 *
 * `null` — это не результат скрининга: без навыков, опыта, образования и
 * вердикта JSON считается обычными данными и остаётся блоком кода.
 */
export function parseResumeCandidate(value: unknown): ResumeCandidate | null {
  const parsed = resumeCandidateSchema.safeParse(unwrapResumePayload(value));

  if (!parsed.success) {
    return null;
  }

  const candidate = normalizeCandidate(parsed.data);
  const hasResumeData =
    candidate.skills.length > 0 ||
    candidate.experience.length > 0 ||
    candidate.education.length > 0 ||
    candidate.verdict !== null;

  return hasResumeData ? candidate : null;
}

/** Разбирает строку с JSON резюме; невалидный JSON — `null`. */
export function parseResumeJson(json: string): ResumeCandidate | null {
  const trimmed = json.trim();

  if (!trimmed.startsWith('{')) {
    return null;
  }

  try {
    return parseResumeCandidate(JSON.parse(trimmed));
  } catch {
    return null;
  }
}
