import axios, { type InternalAxiosRequestConfig } from 'axios'
import { useWorkspaceStore } from '../store/workspace.store'
import { useRateLimitStore } from './rate-limit'

/**
 * Базовый URL REST API.
 *
 * В dev используется прокси Vite (`/api` → `http://localhost:3001`): у API
 * не включён CORS для REST, а прокси сохраняет контракт `/api/v1/*`.
 * Для запуска против другого хоста задайте `VITE_API_URL`.
 */
const API_BASE_URL = import.meta.env.VITE_API_URL ?? '/api/v1'

export const api = axios.create({
  baseURL: API_BASE_URL,
  headers: { 'Content-Type': 'application/json' },
})

/** Подставляет access-токен во все последующие запросы. */
export function setAuthToken(token: string | null): void {
  if (token === null) {
    delete api.defaults.headers.common.Authorization
    return
  }

  api.defaults.headers.common.Authorization = `Bearer ${token}`
}

/**
 * Все запросы приложения помечаются активным воркспейсом (Sprint 31).
 * Значение берётся из стора в момент запроса: смена воркспейса сразу
 * действует на последующие вызовы без пересоздания axios-инстанса.
 */
export function applyWorkspaceHeader(
  config: InternalAxiosRequestConfig,
): InternalAxiosRequestConfig {
  const workspaceId = useWorkspaceStore.getState().activeWorkspaceId;

  if (workspaceId !== null && workspaceId !== '') {
    config.headers.set('X-Workspace-Id', workspaceId);
  }

  return config;
}

api.interceptors.request.use(applyWorkspaceHeader);

// 429 приходит при брутфорсе логина и при превышении лимитов API:
// показываем один общий тост независимо от того, какой запрос упал.
api.interceptors.response.use(
  (response) => response,
  (error: unknown) => {
    if (axios.isAxiosError(error) && error.response?.status === 429) {
      useRateLimitStore.getState().notify()
    }

    return Promise.reject(error)
  },
)
