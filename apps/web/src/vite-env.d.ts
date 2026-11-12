/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Базовый URL REST API. По умолчанию используется dev-прокси `/api/v1`. */
  readonly VITE_API_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
