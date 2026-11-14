import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiException } from '../../common/api-error.js';
import { ERROR_KEYS } from '../../i18n/error-keys.js';
import type { SandboxService } from '../../sandbox/sandbox.service.js';
import {
  OcrSmartEngineService,
  assertImagePayload,
  readOcrConfig,
  readOcrText,
  type OcrInput,
} from './ocr-smart-engine.service.js';

const OCR_HOST = 'https://ocr.example.com';
const OCR_URL = `${OCR_HOST}/v1/recognize`;
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** Переменные окружения, которые меняют тесты. */
const ENV_KEYS = [
  'OCR_API_URL',
  'OCR_API_KEY',
  'OCR_API_AUTH_HEADER',
  'OCR_API_AUTH_PREFIX',
  'OCR_API_TIMEOUT_MS',
  'OCR_MAX_POLL_ATTEMPTS',
  'OCR_POLL_INTERVAL_MS',
  'OCR_TESSERACT_ENABLED',
  'OCR_TESSERACT_LANG',
  'OCR_MAX_IMAGE_BYTES',
  'OUTBOUND_ALLOWLIST',
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

  for (const key of ENV_KEYS) {
    delete process.env[key];
  }

  process.env.OUTBOUND_ALLOWLIST = 'ocr.example.com';
  process.env.OCR_POLL_INTERVAL_MS = '1';
});

afterEach(() => {
  nock.cleanAll();

  for (const key of ENV_KEYS) {
    const value = saved[key];

    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

function sandbox(output = 'Распознанный текст'): {
  runCommand: ReturnType<typeof vi.fn>;
} {
  return { runCommand: vi.fn(async () => output) };
}

function service(fake = sandbox()): {
  service: OcrSmartEngineService;
  fake: { runCommand: ReturnType<typeof vi.fn> };
} {
  return {
    service: new OcrSmartEngineService(
      fake as unknown as SandboxService,
    ),
    fake,
  };
}

const INPUT: OcrInput = {
  imageBase64: PNG_BASE64,
  mimeType: 'image/png',
};

describe('readOcrConfig', () => {
  it('по умолчанию API выключен, Tesseract включён', () => {
    expect(readOcrConfig({})).toEqual({
      apiUrl: null,
      apiKey: null,
      authHeader: 'Authorization',
      authPrefix: 'Bearer',
      timeoutMs: 60_000,
      maxPollAttempts: 10,
      pollIntervalMs: 2_000,
      tesseractEnabled: true,
      tesseractLang: 'rus+eng',
      maxImageBytes: 8 * 1024 * 1024,
    });
  });

  it('читает адрес, ключ и отключает Tesseract', () => {
    expect(
      readOcrConfig({
        OCR_API_URL: OCR_URL,
        OCR_API_KEY: 'secret',
        OCR_API_AUTH_HEADER: 'X-API-KEY',
        OCR_API_AUTH_PREFIX: '',
        OCR_TESSERACT_ENABLED: 'false',
        OCR_TESSERACT_LANG: 'eng',
      }),
    ).toMatchObject({
      apiUrl: OCR_URL,
      apiKey: 'secret',
      authHeader: 'X-API-KEY',
      authPrefix: '',
      tesseractEnabled: false,
      tesseractLang: 'eng',
    });
  });
});

describe('assertImagePayload', () => {
  it('отклоняет не-base64 и слишком большое изображение', () => {
    expect(() =>
      assertImagePayload({ imageBase64: 'не base64!', mimeType: 'image/png' }, 100),
    ).toThrow(/base64/);
    expect(() =>
      assertImagePayload(
        { imageBase64: PNG_BASE64, mimeType: 'image/png' },
        10,
      ),
    ).toThrow(/изображение больше/);
  });
});

describe('readOcrText', () => {
  it('сводит ответы разных вендоров к одному тексту', () => {
    expect(readOcrText({ text: 'a' })).toBe('a');
    expect(readOcrText({ result: { text: 'b' } })).toBe('b');
    expect(
      readOcrText({ result: { textAnnotation: { fullText: 'c' } } }),
    ).toBe('c');
    expect(readOcrText({ data: { text: 'd' } })).toBe('d');
    expect(readOcrText({ pages: [{ text: 'e' }, { text: 'f' }] })).toBe('e\nf');
    expect(
      readOcrText({ status: 'processing', taskId: 't1' }),
    ).toBeNull();
  });
});

describe('OcrSmartEngineService: API', () => {
  it('отправляет изображение и возвращает текст SDE', async () => {
    process.env.OCR_API_URL = OCR_URL;
    process.env.OCR_API_KEY = 'secret';

    const scope = nock(OCR_HOST)
      .post('/v1/recognize', (body: Record<string, unknown>) => {
        expect(body).toEqual({
          content: PNG_BASE64,
          mimeType: 'image/png',
          language: 'rus+eng',
        });

        return true;
      })
      .matchHeader('authorization', 'Bearer secret')
      .reply(200, { text: 'Договор № 1' });

    const { service: ocr } = service();
    const result = await ocr.recognize(INPUT);

    expect(result).toEqual({
      text: 'Договор № 1',
      engine: 'smart-document-engine',
      language: 'rus+eng',
      warnings: [],
    });
    expect(scope.isDone()).toBe(true);
  });

  it('поддерживает вложенный ответ Yandex-подобного OCR', async () => {
    process.env.OCR_API_URL = OCR_URL;

    nock(OCR_HOST)
      .post('/v1/recognize')
      .reply(200, {
        result: { textAnnotation: { fullText: 'Итого: 150 000 ₽' } },
      });

    const result = await service().service.recognize(INPUT);

    expect(result.text).toBe('Итого: 150 000 ₽');
  });

  it('опрашивает асинхронную задачу до готовности', async () => {
    process.env.OCR_API_URL = OCR_URL;
    process.env.OCR_MAX_POLL_ATTEMPTS = '3';

    nock(OCR_HOST)
      .post('/v1/recognize')
      .reply(200, { status: 'processing', taskId: 'task/1' });
    nock(OCR_HOST)
      .get('/v1/recognize/task%2F1')
      .reply(200, { status: 'processing', taskId: 'task/1' });
    nock(OCR_HOST)
      .get('/v1/recognize/task%2F1')
      .reply(200, { pages: [{ text: 'Готово' }] });

    const result = await service().service.recognize(INPUT);

    expect(result.text).toBe('Готово');
  });

  it('не завершившаяся задача — 502 (fallback отключён)', async () => {
    process.env.OCR_API_URL = OCR_URL;
    process.env.OCR_MAX_POLL_ATTEMPTS = '1';
    process.env.OCR_TESSERACT_ENABLED = 'false';

    nock(OCR_HOST).post('/v1/recognize').reply(200, {
      status: 'processing',
      taskId: 'task-1',
    });
    nock(OCR_HOST).get('/v1/recognize/task-1').reply(200, {
      status: 'processing',
      taskId: 'task-1',
    });

    const error: unknown = await service()
      .service.recognize(INPUT)
      .catch((caught: unknown) => caught);

    expect((error as ApiException).getResponse()).toMatchObject({
      statusCode: 502,
      code: ERROR_KEYS.providerUnavailable,
    });
  });

  it('недоступный API переключается на Tesseract', async () => {
    process.env.OCR_API_URL = OCR_URL;

    nock(OCR_HOST).post('/v1/recognize').twice().reply(503, {
      error: 'maintenance',
    });

    const { service: ocr, fake } = service(sandbox('Текст из Tesseract'));
    const result = await ocr.recognize(INPUT);

    expect(result).toEqual({
      text: 'Текст из Tesseract',
      engine: 'tesseract',
      language: 'rus+eng',
      warnings: ['Smart Document Engine недоступен, использован Tesseract'],
    });
    expect(fake.runCommand).toHaveBeenCalledWith(
      expect.stringContaining('tesseract /tmp/ocr/input.png stdout'),
      {
        OCR_IMAGE_B64: PNG_BASE64,
        OCR_LANG: 'rus+eng',
      },
    );
  });

  it('с отключённым fallback ошибка провайдера пробрасывается', async () => {
    process.env.OCR_API_URL = OCR_URL;
    process.env.OCR_TESSERACT_ENABLED = 'false';

    nock(OCR_HOST).post('/v1/recognize').twice().reply(500);

    const { service: ocr, fake } = service();

    await expect(ocr.recognize(INPUT)).rejects.toMatchObject({
      status: 502,
    });
    expect(fake.runCommand).not.toHaveBeenCalled();
  });
});

describe('OcrSmartEngineService: Tesseract', () => {
  it('работает без API: распознаёт через песочницу', async () => {
    const { service: ocr, fake } = service(sandbox('  Скан договора \n'));

    const result = await ocr.recognize({ ...INPUT, language: 'ru' });

    expect(result).toEqual({
      text: 'Скан договора',
      engine: 'tesseract',
      language: 'ru',
      warnings: [],
    });
    expect(fake.runCommand).toHaveBeenCalledWith(
      expect.stringContaining('-l "$OCR_LANG"'),
      { OCR_IMAGE_B64: PNG_BASE64, OCR_LANG: 'ru' },
    );
  });

  it('сообщает, если tesseract отсутствует в образе песочницы', async () => {
    const { service: ocr } = service(sandbox('OCR_TESSERACT_MISSING'));

    const error: unknown = await ocr
      .recognize(INPUT)
      .catch((caught: unknown) => caught);

    expect((error as ApiException).getResponse()).toMatchObject({
      statusCode: 503,
      code: ERROR_KEYS.providerNotConfigured,
    });
  });

  it('пустой результат Tesseract — 502', async () => {
    const { service: ocr } = service(sandbox('   '));

    await expect(ocr.recognize(INPUT)).rejects.toMatchObject({ status: 502 });
  });

  it('без API и без Tesseract — 503 с подсказкой', async () => {
    process.env.OCR_TESSERACT_ENABLED = 'false';

    const { service: ocr } = service();

    const error: unknown = await ocr
      .recognize(INPUT)
      .catch((caught: unknown) => caught);

    expect((error as ApiException).getResponse()).toMatchObject({
      statusCode: 503,
      code: ERROR_KEYS.providerNotConfigured,
    });
    expect(ocr.isApiConfigured()).toBe(false);
  });
});
