import { useQuery } from '@tanstack/react-query';
import { fetchBalance } from '../lib/billing';
import { useAuthStore } from '../store/auth.store';

/** Ключ кэша баланса; используется и для инвалидации после пополнения. */
export const balanceQueryKey = ['balance'] as const;

export function useBalance() {
  const accessToken = useAuthStore((state) => state.accessToken);

  return useQuery({
    queryKey: balanceQueryKey,
    queryFn: fetchBalance,
    enabled: accessToken !== null,
    staleTime: 30_000,
  });
}
