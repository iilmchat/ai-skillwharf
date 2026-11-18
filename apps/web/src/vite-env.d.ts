/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Базовый URL REST API. По умолчанию используется dev-прокси `/api/v1`. */
  readonly VITE_API_URL?: string;
  /**
   * Включает раздел RAG-памяти на странице настроек.
   * По умолчанию выключен: read-endpoint памяти ещё не задеплоен (KI-023).
   */
  readonly VITE_RAG_MEMORY_ENABLED?: string;
  /** Адрес для формы «Связаться с нами». По умолчанию `skillwharf@iiruchating.ru`. */
  readonly VITE_CONTACT_EMAIL?: string;
  /**
   * Вебхук заявок Design Partner с лендинга: `POST` JSON
   * `{ name, contact, track, comment?, source, language, submittedAt }`.
   * Пустое значение — форма собирает `mailto:` и текст для Telegram.
   */
  readonly VITE_LEAD_WEBHOOK_URL?: string;
  /**
   * Страница CloudTips для секции «Поддержка». Пустое значение скрывает
   * секцию целиком — так лендинг не показывает нерабочую кнопку.
   */
  readonly VITE_CLOUDTIPS_URL?: string;
  /** QR-код той же страницы CloudTips (файл в `apps/web/public`). */
  readonly VITE_CLOUDTIPS_QR?: string;
  /**
   * База приложения для статического лендинга (например,
   * `https://app.skillwharf.ru`). Пусто — ссылки остаются относительными.
   */
  readonly VITE_APP_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
