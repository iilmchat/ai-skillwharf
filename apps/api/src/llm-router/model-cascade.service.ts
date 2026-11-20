import { Injectable, Optional } from '@nestjs/common';
import { z } from 'zod';
import type { LlmRouteSelection } from './llm-router.service.js';

export type ModelTier = 'lite' | 'standard' | 'flagship';

/** Маркеры сложной работы: договоры, сверки, аудит, код и т.п. */
export const CASCADE_FLAGSHIP_MARKERS = [
  'договор',
  'сверка',
  'анализ',
  'отчёт',
  'отчет',
  'упд',
  'маркировка',
  'аудит',
  'код',
  'исследован',
  'прогноз',
] as const;

const LITE_MAX_CHARS = 160;
const FLAGSHIP_MIN_CHARS = 800;

/** Детерминированная классификация сложности запроса (CASCADE-44.1). */
export function classifyQueryComplexity(
  prompt: string,
  hasTools: boolean,
): ModelTier {
  const normalized = prompt.trim().toLowerCase();
  const hasFlagshipMarker = CASCADE_FLAGSHIP_MARKERS.some((marker) =>
    normalized.includes(marker),
  );

  if (normalized.length > FLAGSHIP_MIN_CHARS || hasFlagshipMarker) {
    return 'flagship';
  }

  if (normalized.length < LITE_MAX_CHARS && !hasTools) {
    return 'lite';
  }

  return 'standard';
}

const cascadeConfigSchema = z.object({
  enabled: z.boolean(),
  // Пустая строка допустима: каскад может быть выключен.
  liteModel: z.string().trim().max(128),
});

export interface CascadeDecision {
  readonly routes: readonly LlmRouteSelection[];
  readonly modelTier: ModelTier;
}

/** Каскад моделей: простые запросы — на lite, сложные остаются на flagship. */
@Injectable()
export class ModelCascadeService {
  private readonly config: z.infer<typeof cascadeConfigSchema>;

  constructor(@Optional() env: NodeJS.ProcessEnv = process.env) {
    const flag = z.enum(['true', 'false']).catch('false');

    this.config = cascadeConfigSchema.parse({
      enabled:
        flag.parse((env.LLM_CASCADE_ENABLED ?? '').trim().toLowerCase()) ===
        'true',
      liteModel: (env.LLM_CASCADE_LITE_MODEL ?? '').trim(),
    });
  }

  get enabled(): boolean {
    return this.config.enabled;
  }

  /** Возвращает маршруты с подставленной lite-моделью и уровень запроса. */
  apply(
    routes: readonly LlmRouteSelection[],
    prompt: string,
    hasTools: boolean,
  ): CascadeDecision {
    const modelTier = classifyQueryComplexity(prompt, hasTools);

    if (
      !this.config.enabled ||
      modelTier !== 'lite' ||
      routes.length === 0 ||
      this.config.liteModel === ''
    ) {
      return { routes, modelTier };
    }

    const [first, ...rest] = routes;

    return {
      modelTier,
      routes: [{ ...first!, modelName: this.config.liteModel }, ...rest],
    };
  }
}
