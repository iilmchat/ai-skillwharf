import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import {
  invalidRequestError,
  providerNotConfiguredError,
  providerUnavailableError,
} from '../../common/api-error.js';
import {
  providerRequest,
  type ProviderRetryPolicy,
} from '../../integrations/provider-http.js';
import { SandboxService } from '../../sandbox/sandbox.service.js';

/**
 * OCR документов: Smart Document Engine через HTTP API и Tesseract как
 * локальный fallback.
 *
 * Основной путь — реальный вызов распознавания по адресу `OCR_API_URL`
 * (SDE или совместимый сервис). Запрос и ответ описаны Zod-схемами:
 * `{ content: <base64>, mimeType, language }` → `{ text }`, а для сервисов с
 * асинхронной обработкой поддерживается `{ status: 'processing', taskId }`
 * с опросом результата. Ответы разных вендоров сводятся к одному контракту:
 * `text`, `result.text`, `result.textAnnotation.fullText`, `data.text`,
 * `pages[].text`.
 *
 * Fallback — Tesseract в песочнице (`tesseract <file> stdout -l <lang>`):
 * работает без внешней сети, но требует пакет `tesseract-ocr` в образе
 * `sandbox-worker` (см. `sandbox/Dockerfile`).
 */

/** MIME-типы, которые принимает OCR. */
export const OCR_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/tiff',
  'image/bmp',
  'image/webp',
] as const;

export type OcrMimeType = (typeof OCR_MIME_TYPES)[number];

/** Конфигурация OCR из окружения. */
export interface OcrConfig {
  /** Полный URL эндпоинта распознавания; `null` — API не настроен. */
  readonly apiUrl: string | null;
  readonly apiKey: string | null;
  readonly authHeader: string;
  readonly authPrefix: string;
  readonly timeoutMs: number;
  readonly maxPollAttempts: number;
  readonly pollIntervalMs: number;
  readonly tesseractEnabled: boolean;
  readonly tesseractLang: string;
  readonly maxImageBytes: number;
}

/** Вход OCR. */
export interface OcrInput {
  readonly imageBase64: string;
  readonly mimeType: OcrMimeType;
  readonly language?: string;
}

/** Результат распознавания. */
export interface OcrResult {
  readonly text: string;
  readonly engine: 'smart-document-engine' | 'tesseract';
  readonly language: string;
  readonly warnings: readonly string[];
}

/** Политика повторов для OCR: одна попытка на запрос, опрос — отдельно. */
const OCR_RETRY: ProviderRetryPolicy = {
  maxAttempts: 2,
  baseDelayMs: 500,
  maxDelayMs: 2_000,
  maxRetryAfterMs: 5_000,
};

/** Маркер отсутствия tesseract в песочнице. */
const TESSERACT_MISSING_MARKER = 'OCR_TESSERACT_MISSING';

const textNodeSchema = z.object({ text: z.string() });

const ocrResponseSchema = z.union([
  z.object({ text: z.string() }).passthrough(),
  z
    .object({
      result: z.union([
        z.object({ text: z.string() }).passthrough(),
        z
          .object({
            textAnnotation: z.object({ fullText: z.string() }).passthrough(),
          })
          .passthrough(),
      ]),
    })
    .passthrough(),
  z.object({ data: z.object({ text: z.string() }).passthrough() }).passthrough(),
  z.object({ pages: z.array(textNodeSchema).min(1) }).passthrough(),
  z
    .object({ status: z.literal('processing'), taskId: z.string().min(1) })
    .passthrough(),
]);

type OcrResponse = z.infer<typeof ocrResponseSchema>;

/** Расширение файла для tesseract по MIME-типу. */
const EXTENSIONS: Readonly<Record<OcrMimeType, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/tiff': 'tiff',
  'image/bmp': 'bmp',
  'image/webp': 'webp',
};

/** Конфигурация из окружения (читается на каждый вызов: тесты меняют env). */
export function readOcrConfig(env: NodeJS.ProcessEnv = process.env): OcrConfig {
  const apiUrl = env.OCR_API_URL?.trim() ?? '';
  const apiKey = env.OCR_API_KEY?.trim() ?? '';
  const tesseractFlag = (env.OCR_TESSERACT_ENABLED ?? 'true').trim().toLowerCase();

  return {
    apiUrl: apiUrl === '' ? null : apiUrl,
    apiKey: apiKey === '' ? null : apiKey,
    authHeader: env.OCR_API_AUTH_HEADER?.trim() || 'Authorization',
    authPrefix: env.OCR_API_AUTH_PREFIX ?? 'Bearer',
    timeoutMs: readPositiveInt(env.OCR_API_TIMEOUT_MS, 60_000),
    maxPollAttempts: readPositiveInt(env.OCR_MAX_POLL_ATTEMPTS, 10),
    pollIntervalMs: readPositiveInt(env.OCR_POLL_INTERVAL_MS, 2_000),
    tesseractEnabled: tesseractFlag !== 'false' && tesseractFlag !== '0',
    tesseractLang: env.OCR_TESSERACT_LANG?.trim() || 'rus+eng',
    maxImageBytes: readPositiveInt(env.OCR_MAX_IMAGE_BYTES, 8 * 1024 * 1024),
  };
}

/** Проверяет base64 и размер изображения. */
export function assertImagePayload(
  input: OcrInput,
  maxImageBytes: number,
): void {
  const base64 = input.imageBase64.trim();

  if (base64 === '' || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw invalidRequestError('OCR: изображение должно быть в base64');
  }

  const bytes = Math.floor((base64.length * 3) / 4);

  if (bytes > maxImageBytes) {
    throw invalidRequestError(
      `OCR: изображение больше ${Math.floor(maxImageBytes / 1024)} КиБ`,
    );
  }
}

/** Достаёт распознанный текст из ответа провайдера. */
export function readOcrText(payload: OcrResponse): string | null {
  const record = payload as Record<string, unknown>;
  const direct = record.text;

  if (typeof direct === 'string') {
    return direct;
  }

  const result = record.result;

  if (isRecord(result)) {
    const text = result.text;

    if (typeof text === 'string') {
      return text;
    }

    const annotation = result.textAnnotation;

    if (isRecord(annotation) && typeof annotation.fullText === 'string') {
      return annotation.fullText;
    }
  }

  const data = record.data;

  if (isRecord(data) && typeof data.text === 'string') {
    return data.text;
  }

  const pages = record.pages;

  if (Array.isArray(pages)) {
    const texts = pages
      .map((page) => (isRecord(page) && typeof page.text === 'string' ? page.text : null))
      .filter((text): text is string => text !== null);

    return texts.length === 0 ? null : texts.join('\n');
  }

  return null;
}

/** Идентификатор асинхронной задачи, если провайдер его вернул. */
function readTaskId(payload: OcrResponse): string | null {
  const record = payload as Record<string, unknown>;
  const taskId = record.taskId;

  return typeof taskId === 'string' && taskId !== '' ? taskId : null;
}

/** Проверка «обычный объект» без `any`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

@Injectable()
export class OcrSmartEngineService {
  private readonly logger = new Logger(OcrSmartEngineService.name);

  constructor(private readonly sandbox: SandboxService) {}

  /** Настроен ли HTTP API распознавания. */
  isApiConfigured(): boolean {
    return readOcrConfig().apiUrl !== null;
  }

  /**
   * Распознаёт изображение: сначала API, затем Tesseract.
   *
   * @throws ApiException 503, если не настроено ни то, ни другое;
   *         502 — если провайдер недоступен и fallback запрещён.
   */
  async recognize(input: OcrInput): Promise<OcrResult> {
    const config = readOcrConfig();
    const language = input.language?.trim() || config.tesseractLang;

    assertImagePayload(input, config.maxImageBytes);

    if (config.apiUrl !== null) {
      try {
        const text = await this.recognizeViaApi(input, config, language);

        return {
          text,
          engine: 'smart-document-engine',
          language,
          warnings: [],
        };
      } catch (error) {
        if (!config.tesseractEnabled) {
          throw error;
        }

        this.logger.warn(
          JSON.stringify({
            event: 'ocr.api_failed_fallback',
            engine: 'tesseract',
            message: error instanceof Error ? error.message : String(error),
          }),
        );

        const fallback = await this.recognizeViaTesseract(
          input,
          config,
          language,
        );

        return {
          ...fallback,
          warnings: [
            'Smart Document Engine недоступен, использован Tesseract',
          ],
        };
      }
    }

    if (config.tesseractEnabled) {
      return this.recognizeViaTesseract(input, config, language);
    }

    throw providerNotConfiguredError(
      'OCR не настроен: задайте OCR_API_URL или разрешите Tesseract (OCR_TESSERACT_ENABLED)',
    );
  }

  /** Вызов HTTP API с опросом асинхронной задачи. */
  private async recognizeViaApi(
    input: OcrInput,
    config: OcrConfig,
    language: string,
  ): Promise<string> {
    const url = config.apiUrl;

    if (url === null) {
      throw providerNotConfiguredError('OCR: OCR_API_URL не задан');
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (config.apiKey !== null) {
      const prefix = config.authPrefix.trim();

      headers[config.authHeader] =
        prefix === '' ? config.apiKey : `${prefix} ${config.apiKey}`;
    }

    let payload = await providerRequest({
      provider: 'ocr',
      method: 'POST',
      url,
      headers,
      data: {
        content: input.imageBase64.trim(),
        mimeType: input.mimeType,
        language,
      },
      schema: ocrResponseSchema,
      timeoutMs: config.timeoutMs,
      retry: OCR_RETRY,
      logger: this.logger,
    });

    for (let attempt = 0; attempt < config.maxPollAttempts; attempt += 1) {
      const taskId = readTaskId(payload);

      if (taskId === null) {
        break;
      }

      await sleep(config.pollIntervalMs);
      payload = await providerRequest({
        provider: 'ocr',
        method: 'GET',
        url: `${url.replace(/\/$/, '')}/${encodeURIComponent(taskId)}`,
        headers,
        schema: ocrResponseSchema,
        timeoutMs: config.timeoutMs,
        retry: OCR_RETRY,
        logger: this.logger,
      });
    }

    const pendingTaskId = readTaskId(payload);

    if (pendingTaskId !== null && 'status' in payload) {
      throw providerUnavailableError(
        `OCR: задача ${pendingTaskId} не завершилась за ${config.maxPollAttempts} опросов`,
      );
    }

    const text = readOcrText(payload)?.trim() ?? '';

    if (text === '') {
      throw providerUnavailableError('OCR: провайдер вернул пустой текст');
    }

    return text;
  }

  /** Tesseract в песочнице: без сети, результат — stdout. */
  private async recognizeViaTesseract(
    input: OcrInput,
    config: OcrConfig,
    language: string,
  ): Promise<OcrResult> {
    const extension = EXTENSIONS[input.mimeType];
    const script = [
      'set -u',
      `if ! command -v tesseract >/dev/null 2>&1; then printf '${TESSERACT_MISSING_MARKER}'; exit 0; fi`,
      'mkdir -p /tmp/ocr',
      `printf %s "$OCR_IMAGE_B64" | base64 -d > /tmp/ocr/input.${extension}`,
      `tesseract /tmp/ocr/input.${extension} stdout -l "$OCR_LANG"`,
    ].join('\n');
    const output = await this.sandbox.runCommand(script, {
      OCR_IMAGE_B64: input.imageBase64.trim(),
      OCR_LANG: language,
    });

    if (output.startsWith(TESSERACT_MISSING_MARKER)) {
      throw providerNotConfiguredError(
        'OCR: tesseract не установлен в образе sandbox-worker (см. sandbox/Dockerfile)',
      );
    }

    const text = output.trim();

    if (text === '') {
      throw providerUnavailableError('OCR: Tesseract не распознал текст');
    }

    return { text, engine: 'tesseract', language, warnings: [] };
  }
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
