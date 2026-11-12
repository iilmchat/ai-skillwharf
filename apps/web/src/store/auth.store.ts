import { isAxiosError } from 'axios';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import i18n from '../i18n';
import { api, setAuthToken } from '../lib/api';

export interface AuthUser {
  id: string;
  email: string;
  role: string;
}

interface AuthTokensResponse {
  accessToken: string;
  refreshToken: string;
}

interface AuthState {
  accessToken: string | null;
  user: AuthUser | null;
  isSubmitting: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  clearError: () => void;
}

interface ApiErrorBody {
  message: string | string[];
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null || !('message' in value)) {
    return false;
  }

  const { message } = value as { message?: unknown };

  return (
    typeof message === 'string' ||
    (Array.isArray(message) &&
      message.every((item): item is string => typeof item === 'string'))
  );
}

function toErrorMessage(error: unknown): string {
  if (isAxiosError(error)) {
    if (error.response === undefined) {
      return i18n.t('auth.errors.network');
    }

    // Для 401 показываем локализованный текст, а не сообщение бэкенда.
    if (error.response.status === 401) {
      return i18n.t('auth.errors.invalidCredentials');
    }

    const data: unknown = error.response.data;

    if (isApiErrorBody(data)) {
      return Array.isArray(data.message)
        ? data.message.join('; ')
        : data.message;
    }
  }

  return i18n.t('auth.errors.loginFailed');
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      accessToken: null,
      user: null,
      isSubmitting: false,
      error: null,

      login: async (email, password) => {
        set({ isSubmitting: true, error: null });

        try {
          const { data } = await api.post<AuthTokensResponse>('/auth/login', {
            email,
            password,
          });

          setAuthToken(data.accessToken);

          // Login возвращает только токены, профиль запрашиваем отдельно.
          const profile = await api.get<AuthUser>('/auth/me');

          set({
            accessToken: data.accessToken,
            user: profile.data,
            isSubmitting: false,
          });
        } catch (error) {
          setAuthToken(null);
          set({
            accessToken: null,
            user: null,
            isSubmitting: false,
            error: toErrorMessage(error),
          });

          throw error;
        }
      },

      logout: () => {
        setAuthToken(null);
        set({ accessToken: null, user: null, error: null });
      },

      clearError: () => set({ error: null }),
    }),
    {
      name: 'skillwharf-auth',
      storage: createJSONStorage(() => sessionStorage),
      partialize: (state) => ({
        accessToken: state.accessToken,
        user: state.user,
      }),
      onRehydrateStorage: () => (state) => {
        setAuthToken(state?.accessToken ?? null);
      },
    },
  ),
);
