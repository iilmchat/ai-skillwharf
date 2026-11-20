import { Injectable } from '@nestjs/common';
import {
  providerNotConfiguredError,
  providerUnavailableError,
} from '../common/api-error.js';
import { LlmRouterService } from '../llm-router/llm-router.service.js';
import {
  chatCompletionResponseSchema,
  refineArtifactRequestSchema,
  refineArtifactResponseSchema,
  type RefineArtifactResponse,
} from './dto/refine-artifact.dto.js';

const REFINE_SYSTEM_PROMPT = [
  'Ты редактируешь только выделенный фрагмент артефакта.',
  'Остальное содержимое документа должно остаться без изменений.',
  'Верни строго JSON вида {"updatedContent":"...","summary":"..."} без обёрток и комментариев.',
].join('\n');

/** Аккуратная замена выделенного фрагмента через LLM (UX-37.1). */
@Injectable()
export class ArtifactRefineService {
  constructor(private readonly router: LlmRouterService) {}

  async refine(raw: unknown): Promise<RefineArtifactResponse> {
    const input = refineArtifactRequestSchema.parse(raw);
    const [route] = await this.router.selectRoutes('chat');

    if (route === undefined) {
      throw providerNotConfiguredError(
        'Нет активного LLM-маршрута для редактирования артефакта',
      );
    }

    const apiKey =
      route.apiKeyEnvVar === null ? '' : (process.env[route.apiKeyEnvVar] ?? '');
    const response = await fetch(
      `${route.baseUrl.replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiKey === '' ? {} : { authorization: `Bearer ${apiKey}` }),
        },
        body: JSON.stringify({
          model: route.modelName,
          temperature: 0,
          messages: [
            { role: 'system', content: REFINE_SYSTEM_PROMPT },
            {
              role: 'user',
              content: [
                `Артефакт: ${input.title} (${input.artifactType})`,
                `ПОЛНОЕ СОДЕРЖАНИЕ:\n${input.fullContent}`,
                `ВЫДЕЛЕННЫЙ ФРАГМЕНТ:\n${input.selectedText}`,
                `ИНСТРУКЦИЯ: ${input.instruction}`,
              ].join('\n\n'),
            },
          ],
        }),
        signal: AbortSignal.timeout(30_000),
      },
    );

    if (!response.ok) {
      throw providerUnavailableError(`LLM вернула HTTP ${response.status}`);
    }

    const completion = chatCompletionResponseSchema.safeParse(
      await response.json().catch(() => null),
    );

    if (!completion.success) {
      throw providerUnavailableError('LLM вернула некорректный ответ');
    }

    const content = completion.data.choices[0]!.message.content
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    const parsed: unknown = JSON.parse(content);

    return refineArtifactResponseSchema.parse(parsed);
  }
}
