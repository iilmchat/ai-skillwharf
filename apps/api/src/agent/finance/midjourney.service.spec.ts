import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiException } from '../../common/api-error.js';
import { ERROR_KEYS } from '../../i18n/error-keys.js';
import type { ProviderRetryPolicy } from '../../integrations/provider-http.js';
import { MidjourneyConfig } from './midjourney.config.js';
import { MidjourneyService } from './midjourney.service.js';

/** TTAPI — единственный разрешённый провайдер Midjourney (аудит 11.2026). */
const BASE = 'https://api.ttapi.io';
const API_KEY = 'tt-api-key';
const RETRY: ProviderRetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 1,
  maxDelayMs: 2,
  maxRetryAfterMs: 1_000,
};

function createService(options: {
  pollIntervalMs?: number;
  timeoutMs?: number;
  now?: () => Date;
} = {}): MidjourneyService {
  const config = new MidjourneyConfig(
    API_KEY,
    BASE,
    '/midjourney/v1/imagine',
    '/midjourney/v1/fetch?jobId={id}',
    options.pollIntervalMs ?? 1,
    options.timeoutMs ?? 5_000,
  );

  return new MidjourneyService(
    config,
    RETRY,
    async () => undefined,
    options.now,
  );
}

describe('MidjourneyService (TTAPI: imagine → fetch → image)', () => {
  beforeEach(() => {
    nock.disableNetConnect();
    // Домен TTAPI зафиксирован; allowlist задаём явно, чтобы тест не зависел
    // от дефолтов deploy-окружения.
    process.env.OUTBOUND_ALLOWLIST = 'api.ttapi.io';
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
    delete process.env.OUTBOUND_ALLOWLIST;
    delete process.env.API_OUTBOUND_ALLOWLIST;
  });

  it('POST /midjourney/v1/imagine с TT-API-KEY и mode=fast, затем polling', async () => {
    const submit = nock(BASE)
      .post('/midjourney/v1/imagine', {
        prompt: 'кот в космосе',
        mode: 'fast',
      })
      .matchHeader('TT-API-KEY', API_KEY)
      .reply(200, { jobId: 'job-1' });
    nock(BASE)
      .get('/midjourney/v1/fetch')
      .query({ jobId: 'job-1' })
      .matchHeader('TT-API-KEY', API_KEY)
      .reply(200, { status: 'processing' });
    const ready = nock(BASE)
      .get('/midjourney/v1/fetch')
      .query({ jobId: 'job-1' })
      .reply(200, {
        status: 'completed',
        imageUrl: 'https://cdn.example.com/image.png',
      });

    const result = await createService().generate('кот в космосе');

    expect(result).toEqual({
      taskId: 'job-1',
      imageUrl: 'https://cdn.example.com/image.png',
      status: 'completed',
    });
    expect(submit.isDone()).toBe(true);
    expect(ready.isDone()).toBe(true);
  });

  it('принимает вложенный data.jobId и data.imageUrl', async () => {
    nock(BASE)
      .post('/midjourney/v1/imagine')
      .reply(200, { data: { jobId: 'job-2' } });
    nock(BASE)
      .get('/midjourney/v1/fetch')
      .query({ jobId: 'job-2' })
      .reply(200, {
        data: { status: 'completed', imageUrl: 'https://cdn.example.com/2.png' },
      });

    await expect(createService().generate('промпт')).resolves.toMatchObject({
      taskId: 'job-2',
      imageUrl: 'https://cdn.example.com/2.png',
    });
  });

  it('принимает job_id и image_url (snake_case)', async () => {
    nock(BASE)
      .post('/midjourney/v1/imagine')
      .reply(200, { job_id: 'job-3' });
    nock(BASE)
      .get('/midjourney/v1/fetch')
      .query({ jobId: 'job-3' })
      .reply(200, {
        status: 'completed',
        image_url: 'https://cdn.example.com/3.png',
      });

    await expect(createService().generate('промпт')).resolves.toMatchObject({
      taskId: 'job-3',
      imageUrl: 'https://cdn.example.com/3.png',
    });
  });

  it('повторяет 429 на imagine с учётом Retry-After', async () => {
    nock(BASE)
      .post('/midjourney/v1/imagine')
      .reply(429, { error: { message: 'rate limited' } }, { 'retry-after': '0' });
    nock(BASE)
      .post('/midjourney/v1/imagine')
      .reply(200, { jobId: 'job-4' });
    nock(BASE)
      .get('/midjourney/v1/fetch')
      .query({ jobId: 'job-4' })
      .reply(200, { status: 'completed', imageUrl: 'https://cdn.example.com/4.png' });

    await expect(createService().generate('промпт')).resolves.toMatchObject({
      taskId: 'job-4',
    });
  });

  it('429 после всех повторов — provider_rate_limited', async () => {
    nock(BASE)
      .post('/midjourney/v1/imagine')
      .times(3)
      .reply(429, { error: { message: 'rate limited' } });

    const error: unknown = await createService()
      .generate('промпт')
      .catch((caught: unknown) => caught);

    expect((error as ApiException).getResponse()).toMatchObject({
      statusCode: 429,
      code: ERROR_KEYS.providerRateLimited,
    });
  });

  it('5xx повторяется, затем задача выполняется', async () => {
    nock(BASE)
      .post('/midjourney/v1/imagine')
      .reply(503, { error: 'unavailable' });
    nock(BASE)
      .post('/midjourney/v1/imagine')
      .reply(200, { jobId: 'job-5' });
    nock(BASE)
      .get('/midjourney/v1/fetch')
      .query({ jobId: 'job-5' })
      .reply(200, { status: 'completed', imageUrl: 'https://cdn.example.com/5.png' });

    await expect(createService().generate('промпт')).resolves.toMatchObject({
      taskId: 'job-5',
    });
  });

  it('5xx на fetch тоже повторяется', async () => {
    nock(BASE)
      .post('/midjourney/v1/imagine')
      .reply(200, { jobId: 'job-6' });
    nock(BASE)
      .get('/midjourney/v1/fetch')
      .query({ jobId: 'job-6' })
      .reply(502, { error: 'bad gateway' });
    nock(BASE)
      .get('/midjourney/v1/fetch')
      .query({ jobId: 'job-6' })
      .reply(200, { status: 'completed', imageUrl: 'https://cdn.example.com/6.png' });

    await expect(createService().generate('промпт')).resolves.toMatchObject({
      imageUrl: 'https://cdn.example.com/6.png',
    });
  });

  it('статус failed — ошибка провайдера с причиной', async () => {
    nock(BASE)
      .post('/midjourney/v1/imagine')
      .reply(200, { jobId: 'job-7' });
    nock(BASE)
      .get('/midjourney/v1/fetch')
      .query({ jobId: 'job-7' })
      .reply(200, { status: 'failed', error: 'content policy' });

    const error: unknown = await createService()
      .generate('промпт')
      .catch((caught: unknown) => caught);

    expect((error as ApiException).getResponse()).toMatchObject({
      statusCode: 502,
      code: ERROR_KEYS.providerUnavailable,
    });
    expect((error as Error).message).toContain('content policy');
  });

  it('дедлайн истекает — ошибка провайдера, без фейкового URL', async () => {
    nock(BASE)
      .post('/midjourney/v1/imagine')
      .reply(200, { jobId: 'job-8' });
    nock(BASE)
      .get('/midjourney/v1/fetch')
      .query({ jobId: 'job-8' })
      .times(10)
      .reply(200, { status: 'processing' });

    const nowValues = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    let index = 0;

    const error: unknown = await createService({
      pollIntervalMs: 1,
      timeoutMs: 2,
      now: () =>
        new Date(
          nowValues[Math.min(index++, nowValues.length - 1)] ?? 0,
        ),
    })
      .generate('промпт')
      .catch((caught: unknown) => caught);

    expect((error as ApiException).getResponse()).toMatchObject({
      statusCode: 502,
      code: ERROR_KEYS.providerUnavailable,
    });
    expect((error as Error).message).toContain('не завершилась');
  });

  it('без MIDJOURNEY_API_KEY — provider_not_configured, без сети', async () => {
    const service = new MidjourneyService(
      new MidjourneyConfig(
        null,
        BASE,
        '/midjourney/v1/imagine',
        '/midjourney/v1/fetch?jobId={id}',
        1,
        1_000,
      ),
      RETRY,
    );
    const error: unknown = await service
      .generate('промпт')
      .catch((caught: unknown) => caught);

    expect((error as ApiException).getResponse()).toMatchObject({
      statusCode: 503,
      code: ERROR_KEYS.providerNotConfigured,
    });
  });

  it('ответ без jobId — ошибка провайдера', async () => {
    nock(BASE).post('/midjourney/v1/imagine').reply(200, { status: 'ok' });

    const error: unknown = await createService()
      .generate('промпт')
      .catch((caught: unknown) => caught);

    expect((error as ApiException).getResponse()).toMatchObject({
      code: ERROR_KEYS.providerUnavailable,
    });
    expect((error as Error).message).toContain('jobId');
  });
});

describe('MidjourneyService: ключ пользователя из БД', () => {
  beforeEach(() => {
    nock.disableNetConnect();
    process.env.OUTBOUND_ALLOWLIST = 'api.ttapi.io';
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
    delete process.env.OUTBOUND_ALLOWLIST;
    delete process.env.MIDJOURNEY_API_KEY;
  });

  /** Сервис с подменённым резолвером ключей пользователя. */
  function withUserKey(
    resolve: () => Promise<{ apiKey: string; source: 'user' | 'env' } | null>,
    apiKey: string | null = 'env-key',
  ): { service: MidjourneyService; resolve: ReturnType<typeof vi.fn> } {
    const resolveMock = vi.fn(resolve);
    const config = new MidjourneyConfig(
      apiKey,
      BASE,
      '/midjourney/v1/imagine',
      '/midjourney/v1/fetch?jobId={id}',
      1,
      5_000,
    );
    const service = new MidjourneyService(
      config,
      RETRY,
      async () => undefined,
      () => new Date(0),
      {
        midjourneyKey: resolveMock,
      } as unknown as ConstructorParameters<typeof MidjourneyService>[4],
    );

    return { service, resolve: resolveMock };
  }

  it('ключ пользователя важнее env и уходит в TT-API-KEY', async () => {
    const submit = nock(BASE)
      .post('/midjourney/v1/imagine', { prompt: 'промпт', mode: 'fast' })
      .matchHeader('TT-API-KEY', 'user-key')
      .reply(200, { jobId: 'job-1' });
    nock(BASE)
      .get('/midjourney/v1/fetch')
      .query({ jobId: 'job-1' })
      .matchHeader('TT-API-KEY', 'user-key')
      .reply(200, { status: 'completed', imageUrl: 'https://cdn.example.com/1.png' });

    const { service, resolve } = withUserKey(async () => ({
      apiKey: 'user-key',
      source: 'user',
    }));

    await expect(
      service.generate('промпт', { userId: 'user-1' }),
    ).resolves.toMatchObject({ taskId: 'job-1' });
    expect(resolve).toHaveBeenCalledWith('user-1');
    expect(submit.isDone()).toBe(true);
  });

  it('без ключа в БД использует env', async () => {
    nock(BASE)
      .post('/midjourney/v1/imagine')
      .matchHeader('TT-API-KEY', 'env-key')
      .reply(200, { jobId: 'job-2' });
    nock(BASE)
      .get('/midjourney/v1/fetch')
      .query({ jobId: 'job-2' })
      .reply(200, { status: 'completed', imageUrl: 'https://cdn.example.com/2.png' });

    const { service } = withUserKey(async () => null);

    await expect(
      service.generate('промпт', { userId: 'user-1' }),
    ).resolves.toMatchObject({ taskId: 'job-2' });
  });

  it('нет ни ключа пользователя, ни env — 503 provider_not_configured', async () => {
    const { service } = withUserKey(async () => null, null);

    const error: unknown = await service
      .generate('промпт', { userId: 'user-1' })
      .catch((caught: unknown) => caught);

    expect((error as ApiException).getResponse()).toMatchObject({
      statusCode: 503,
      code: ERROR_KEYS.providerNotConfigured,
    });
    expect((error as Error).message).toContain('Интеграции');
  });
});
