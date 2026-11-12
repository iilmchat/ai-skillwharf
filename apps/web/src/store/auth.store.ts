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
  refreshToken: string | null;
  user: AuthUser | null;
  /** Идёт восстановление сессии после перезагрузки страницы. */
  isInitializing: boolean;
  isSubmitting: boolean;
  error: string | null;
  initialize: () => Promise<void>;
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

/** 429 показывает общий тост из interceptor, дублировать его в форме не нужно. */
function isRateLimited(error: unknown): boolean {
  return isAxiosError(error) && error.response?.status === 429;
}

/**
 * Восстановление сессии должно запускаться один раз: в StrictMode эффект
 * вызывается дважды, а refresh-токен одноразовый — повторный запрос
 * инвалидировал бы только что выданную пару.
 */
let bootstrapPromise: Promise<void> | null = null;

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      accessToken: null,
      refreshToken: null,
      user: null,
      isInitializing: true,
      isSubmitting: false,
      error: null,

      initialize: async () => {
        if (bootstrapPromise !== null) {
          return bootstrapPromise;
        }

        const storedRefreshToken = get().refreshToken;

        if (storedRefreshToken === null) {
          set({ isInitializing: false });

          return;
        }

        bootstrapPromise = (async () => {
          try {
            const { data } = await api.post<AuthTokensResponse>(
              '/auth/refresh',
              { refreshToken: storedRefreshToken },
            );

            setAuthToken(data.accessToken);

            const profile = await api.get<AuthUser>('/auth/me');

            set({
              accessToken: data.accessToken,
              refreshToken: data.refreshToken,
              user: profile.data,
              isInitializing: false,
              error: null,
            });
          } catch {
            // Истёкший или отозванный токен: чистим сессию и идём на /login.
            // 429 отдельно не пишем — его показывает общий тост.
            setAuthToken(null);
            set({
              accessToken: null,
              refreshToken: null,
              user: null,
              isInitializing: false,
              error: null,
            });
          }
        })();

        return bootstrapPromise;
      },

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
            refreshToken: data.refreshToken,
            user: profile.data,
            isSubmitting: false,
          });
        } catch (error) {
          setAuthToken(null);
          set({
            accessToken: null,
            refreshToken: null,
            user: null,
            isSubmitting: false,
            error: isRateLimited(error) ? null : toErrorMessage(error),
          });

          throw error;
        }
      },

      logout: () => {
        setAuthToken(null);
        bootstrapPromise = null;
        set({
          accessToken: null,
          refreshToken: null,
          user: null,
          error: null,
        });
      },

      clearError: () => set({ error: null }),
    }),
    {
      // Refresh-токен переживает F5; access-токен остаётся только в памяти.
      name: 'skillwharf-auth',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ refreshToken: state.refreshToken }),
    },
  ),
);
