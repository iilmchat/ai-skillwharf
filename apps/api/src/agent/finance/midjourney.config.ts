/**
 * Настройки Midjourney через TTAPI.
 *
 * Аудит API (ноябрь 2026): официального Midjourney API нет, единственный
 * разрешённый провайдер — TTAPI (`https://api.ttapi.io`), эндпоинты
 * `/midjourney/v1/imagine` и `/midjourney/v1/fetch?jobId=...`.
 * GoAPI/UseAPI/Discord-обёртки не используются, поэтому базовый URL и пути
 * зафиксированы в коде: окружение задаёт только ключ и таймауты.
 */
export const TTAPI_BASE_URL = 'https://api.ttapi.io';
export const TTAPI_IMAGINE_PATH = '/midjourney/v1/imagine';
export const TTAPI_FETCH_PATH = '/midjourney/v1/fetch?jobId={id}';

export class MidjourneyConfig {
  constructor(
    /** Ключ `MIDJOURNEY_API_KEY` (TTAPI); `null` — интеграция не настроена. */
    readonly apiKey: string | null,
    /** Базовый URL TTAPI (фиксирован, вынесен параметром для тестов). */
    readonly baseUrl: string,
    /** Путь отправки промпта. */
    readonly imaginePath: string,
    /** Шаблон пути статуса; `{id}` заменяется на jobId. */
    readonly taskPath: string,
    /** Интервал поллинга. */
    readonly pollIntervalMs: number,
    /** Общий дедлайн ожидания результата. */
    readonly timeoutMs: number,
  ) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): MidjourneyConfig {
    const apiKey = env.MIDJOURNEY_API_KEY?.trim() ?? '';

    return new MidjourneyConfig(
      apiKey === '' ? null : apiKey,
      TTAPI_BASE_URL,
      TTAPI_IMAGINE_PATH,
      TTAPI_FETCH_PATH,
      positiveInt(env.MIDJOURNEY_POLL_INTERVAL_MS, 2_000),
      positiveInt(env.MIDJOURNEY_TIMEOUT_MS, 120_000),
    );
  }

  isConfigured(): boolean {
    return this.apiKey !== null;
  }
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
