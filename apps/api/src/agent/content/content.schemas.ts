import { z } from 'zod';

/**
 * Zod-схемы аргументов контент-инструментов (`screen_resume`, `check_facts`).
 *
 * Схемы общие для реестра инструментов, политик Agent Gateway и сервисов.
 */

/** Требования вакансии для скрининга резюме. */
export const ResumeRequirementsSchema = z
  .object({
    skills: z
      .array(z.string().min(1).max(100))
      .max(50)
      .optional()
      .describe('Обязательные навыки вакансии'),
    minExperienceYears: z
      .number()
      .min(0)
      .max(60)
      .optional()
      .describe('Минимальный опыт в годах'),
  })
  .strict();

/** `screen_resume`: разбор резюме и сопоставление с требованиями. */
export const ScreenResumeToolSchema = z
  .object({
    resumeText: z.string().min(1).max(50_000).describe('Текст резюме'),
    jobTitle: z.string().min(1).max(200).optional().describe('Название вакансии'),
    requirements: ResumeRequirementsSchema.optional().describe(
      'Требования вакансии: навыки и минимальный опыт',
    ),
  })
  .strict();

/** `check_facts`: проверка утверждений по внешним источникам. */
export const CheckFactsToolSchema = z
  .object({
    text: z.string().min(1).max(20_000).describe('Текст для проверки'),
    maxClaims: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe('Сколько утверждений проверять (по умолчанию 5)'),
    searchDepth: z
      .enum(['basic', 'advanced'])
      .optional()
      .describe('Глубина поиска Tavily'),
  })
  .strict();

export type ScreenResumeToolArgs = z.infer<typeof ScreenResumeToolSchema>;
export type CheckFactsToolArgs = z.infer<typeof CheckFactsToolSchema>;
