import { useQuery } from '@tanstack/react-query';
import {
  fetchIntegrations,
  integrationsQueryKeyFor,
} from '../lib/integrations';
import { useAuthStore } from '../store/auth.store';

/**
 * Состояние интеграций текущего пользователя.
 *
 * Запрос не выполняется без access-токена (например, на публичной странице
 * AI-Офиса) и разделяется по `userId`, чтобы после смены аккаунта не показать
 * чужой статус из кэша.
 */
export function useIntegrations() {
  const accessToken = useAuthStore((state) => state.accessToken);
  const userId = useAuthStore((state) => state.user?.id ?? null);

  return useQuery({
    queryKey: integrationsQueryKeyFor(userId),
    queryFn: fetchIntegrations,
    enabled: accessToken !== null && userId !== null,
    staleTime: 30_000,
  });
}
