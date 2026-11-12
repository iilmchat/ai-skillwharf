/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Базовый URL REST API. По умолчанию используется dev-прокси `/api/v1`. */
  readonly VITE_API_URL?: string;
  /** Адрес Socket.IO-сервера. По умолчанию `http://localhost:3001`. */
  readonly VITE_WS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
