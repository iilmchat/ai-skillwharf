import { isAxiosError } from 'axios';
import i18n from '../i18n';
import { api } from './api';

export type LlmProviderKind = 'OpenAI' | 'YandexGPT' | 'GigaChat' | 'Ollama';

/** Активный маршрут, который обслуживает запросы пользователя. */
export interface ActiveLlmRoute {
  name: string;
  modelName: string;
  providerType?: string;
}

/** Ключ кэша активного провайдера. */
export const activeLlmQueryKey = ['llm', 'active'] as const;

/** Провайдер по умолчанию, если бэкенд не вернул тип. */
export function normalizeProvider(value: unknown): LlmProviderKind {
  if (value === 'YandexGPT' || value === 'GigaChat' || value === 'Ollama') {
    return value;
  }

  if (value === 'OpenAI') {
    return 'OpenAI';
  }

  return 'OpenAI';
}

export async function fetchActiveLlm(): Promise<ActiveLlmRoute | null> {
  try {
    const { data } = await api.get<ActiveLlmRoute | null>('/llm/active');

    return data;
  } catch (error) {
    // Шапка чата не должна падать из-за недоступного роутера.
    if (isAxiosError(error) && error.response?.status === 404) {
      return null;
    }

    throw error;
  }
}

/** Признаки того, что упала авторизация или конфигурация LLM-провайдера. */
export function isLlmAuthError(message: string): boolean {
  const normalized = message.toLowerCase();

  return (
    normalized.includes('llm error') ||
    normalized.includes('unauthorized') ||
    normalized.includes('status code 401') ||
    normalized.includes('invalid api key') ||
    normalized.includes('iam') ||
    normalized.includes('credential') ||
    normalized.includes('не настроен')
  );
}

export function llmAuthErrorMessage(): string {
  return i18n.t('errors.llmAuth');
}
