import { api } from './api';

/**
 * Дневная квота токенов из профиля пользователя.
 *
 * Поля появились на бэкенде не сразу, поэтому ответ `/auth/me` проверяется
 * максимально осторожно: пока их нет, виджет квоты просто не рендерится.
 */
export interface TokenQuota {
  dailyTokenLimit: number;
  dailyTokensUsed: number;
}

interface ProfileResponse {
  dailyTokenLimit?: unknown;
  dailyTokensUsed?: unknown;
}

function isTokenCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Возвращает `null`, если бэкенд ещё не отдаёт корректные поля квоты. */
export async function fetchTokenQuota(): Promise<TokenQuota | null> {
  const { data } = await api.get<ProfileResponse>('/auth/me');

  if (
    !isTokenCounter(data.dailyTokenLimit) ||
    !isTokenCounter(data.dailyTokensUsed) ||
    data.dailyTokenLimit === 0
  ) {
    return null;
  }

  return {
    dailyTokenLimit: data.dailyTokenLimit,
    dailyTokensUsed: data.dailyTokensUsed,
  };
}
