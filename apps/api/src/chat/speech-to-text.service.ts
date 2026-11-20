import { Injectable, Optional } from '@nestjs/common';
import { z } from 'zod';
import {
  documentTooLargeError,
  providerUnavailableError,
} from '../common/api-error.js';

export const SUPPORTED_STT_MIME_TYPES = [
  'audio/webm',
  'audio/ogg',
  'audio/mpeg',
  'audio/wav',
  'audio/mp4',
] as const;

export const MAX_AUDIO_BYTES = 15 * 1024 * 1024;

export const sttRequestSchema = z
  .object({
    audioBase64: z.string().min(1),
    mimeType: z.enum(SUPPORTED_STT_MIME_TYPES),
    language: z.string().trim().min(2).max(20).optional(),
  })
  .strict();
export type SttRequest = z.infer<typeof sttRequestSchema>;

export const sttResponseSchema = z
  .object({
    text: z.string(),
    provider: z.string(),
    durationMs: z.number().nonnegative().optional(),
  })
  .strict();
export type SttResponse = z.infer<typeof sttResponseSchema>;

const sttConfigSchema = z
  .object({
    provider: z.enum(['mock', 'whisper', 'yandex-speechkit']),
    whisperUrl: z.string().default(''),
    yandexIamToken: z.string().default(''),
  })
  .superRefine((config, context) => {
    if (config.provider === 'whisper' && config.whisperUrl.trim() === '') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['whisperUrl'],
        message: 'STT_PROVIDER=whisper требует STT_WHISPER_URL',
      });
    }

    if (
      config.provider === 'yandex-speechkit' &&
      config.yandexIamToken.trim() === ''
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['yandexIamToken'],
        message: 'STT_PROVIDER=yandex-speechkit требует YANDEX_STT_IAM_TOKEN',
      });
    }
  });
export type SttConfig = z.infer<typeof sttConfigSchema>;

const providerResponseSchema = z.object({ text: z.string() });

/** Шлюз транскрибации речи (VOICE-38.1): mock / Whisper / Yandex SpeechKit. */
@Injectable()
export class SpeechToTextService {
  private readonly config: SttConfig;
  private readonly fetchFn: typeof fetch;

  constructor(
    @Optional() env: NodeJS.ProcessEnv = process.env,
    @Optional() fetchFn?: typeof fetch,
  ) {
    this.config = sttConfigSchema.parse({
      provider: (env.STT_PROVIDER ?? 'mock').trim().toLowerCase(),
      whisperUrl: env.STT_WHISPER_URL ?? '',
      yandexIamToken: env.YANDEX_STT_IAM_TOKEN ?? '',
    });
    this.fetchFn = fetchFn ?? fetch;
  }

  async transcribe(raw: unknown): Promise<SttResponse> {
    const input = sttRequestSchema.parse(raw);
    const startedAt = Date.now();
    const buffer = Buffer.from(input.audioBase64, 'base64');

    if (buffer.length > MAX_AUDIO_BYTES) {
      throw documentTooLargeError('Аудиофайл превышает 15 МБ');
    }

    const text = await this.recognize(input, buffer);

    return sttResponseSchema.parse({
      text,
      provider: this.config.provider,
      durationMs: Math.max(0, Date.now() - startedAt),
    });
  }

  private async recognize(input: SttRequest, buffer: Buffer): Promise<string> {
    switch (this.config.provider) {
      case 'mock':
        return `Распознано (${input.language ?? 'ru'}): ${buffer.length} байт аудио`;
      case 'whisper':
        return this.whisper(input, buffer);
      case 'yandex-speechkit':
        return this.yandex(input);
    }
  }

  private async whisper(input: SttRequest, buffer: Buffer): Promise<string> {
    const form = new FormData();
    const bytes = new Uint8Array(buffer.length);

    bytes.set(buffer);
    form.append(
      'file',
      new Blob([bytes], { type: input.mimeType }),
      'audio.webm',
    );
    form.append('model', 'whisper-1');

    const response = await this.fetchFn(
      `${this.config.whisperUrl.replace(/\/+$/, '')}/v1/audio/transcriptions`,
      { method: 'POST', body: form, signal: AbortSignal.timeout(60_000) },
    );

    if (!response.ok) {
      throw providerUnavailableError(`Whisper вернул HTTP ${response.status}`);
    }

    const parsed = providerResponseSchema.safeParse(
      await response.json().catch(() => null),
    );

    if (!parsed.success) {
      throw providerUnavailableError('Whisper вернул некорректный ответ');
    }

    return parsed.data.text;
  }

  private async yandex(input: SttRequest): Promise<string> {
    const response = await this.fetchFn('https://yandex.net', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${this.config.yandexIamToken}`,
      },
      body: JSON.stringify({
        audioBase64: input.audioBase64,
        mimeType: input.mimeType,
        ...(input.language === undefined ? {} : { language: input.language }),
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!response.ok) {
      throw providerUnavailableError(`SpeechKit вернул HTTP ${response.status}`);
    }

    const parsed = providerResponseSchema.safeParse(
      await response.json().catch(() => null),
    );

    if (!parsed.success) {
      throw providerUnavailableError('SpeechKit вернул некорректный ответ');
    }

    return parsed.data.text;
  }
}

/** Файл из multipart-запроса (FileInterceptor, memory storage). */
export interface UploadedAudio {
  readonly buffer: Buffer;
  readonly mimetype: string;
  readonly size: number;
  readonly originalname: string;
}
