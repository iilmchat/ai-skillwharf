/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Базовый URL REST API. По умолчанию используется dev-прокси `/api/v1`. */
  readonly VITE_API_URL?: string;
  /**
   * Включает раздел RAG-памяти на странице настроек.
   * По умолчанию выключен: read-endpoint памяти ещё не реализован (KI-023).
   */
  readonly VITE_RAG_MEMORY_ENABLED?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
