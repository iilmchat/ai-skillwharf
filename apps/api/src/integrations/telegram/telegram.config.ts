/**
 * Настройки Telegram Bot API.
 *
 * Класс (а не интерфейс) нужен Nest: `design:paramtypes` для интерфейса даёт
 * `Object`, и контейнер не может разрешить зависимость. Провайдер помечен
 * `@Optional()`, поэтому в тестах конфиг передаётся явно.
 */
export class TelegramConfig {
  constructor(
    /** Токен бота из BotFather; `null` — интеграция не настроена. */
    readonly botToken: string | null,
    /** Секрет webhook: Telegram присылает его в заголовке. `null` — не задан. */
    readonly webhookSecret: string | null,
    /** Базовый URL API (переопределяется в тестах/nock). */
    readonly apiBaseUrl: string,
  ) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): TelegramConfig {
    const token = env.TELEGRAM_BOT_TOKEN?.trim() ?? '';
    const secret = env.TELEGRAM_WEBHOOK_SECRET?.trim() ?? '';
    const baseUrl =
      env.TELEGRAM_API_BASE_URL?.trim() || 'https://api.telegram.org';

    return new TelegramConfig(
      token === '' ? null : token,
      secret === '' ? null : secret,
      baseUrl.replace(/\/+$/, ''),
    );
  }

  isConfigured(): boolean {
    return this.botToken !== null;
  }
}
