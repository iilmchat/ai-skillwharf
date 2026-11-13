import { isAxiosError } from 'axios';
import i18n from '../i18n';
import { api } from './api';

/** Удаляет всю долговременную память текущего пользователя. */
export async function clearMemory(): Promise<{ deleted: number }> {
  const { data } = await api.delete<{ deleted: number }>('/chat/memory');

  return data;
}

export function getMemoryErrorMessage(error: unknown): string {
  if (isAxiosError(error)) {
    if (error.response === undefined) {
      return i18n.t('settings.memory.network');
    }

    if (error.response.status === 401) {
      return i18n.t('settings.memory.sessionExpired');
    }
  }

  return i18n.t('settings.memory.error');
}
