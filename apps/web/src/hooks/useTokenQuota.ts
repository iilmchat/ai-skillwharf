import { useQuery } from '@tanstack/react-query';
import { fetchTokenQuota } from '../lib/profile';
import { useAuthStore } from '../store/auth.store';

/** Ключ кэша дневной квоты; по нему обновляем счётчик после ответа чата. */
export const tokenQuotaQueryKey = ['auth', 'me', 'token-quota'] as const;

export function useTokenQuota() {
  const accessToken = useAuthStore((state) => state.accessToken);

  return useQuery({
    queryKey: tokenQuotaQueryKey,
    queryFn: fetchTokenQuota,
    enabled: accessToken !== null,
    staleTime: 30_000,
    retry: false,
  });
}
