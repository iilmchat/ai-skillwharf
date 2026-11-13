import { useQuery } from '@tanstack/react-query';
import {
  fetchPendingApprovals,
  pendingApprovalsQueryKey,
} from '../lib/pending-approvals';
import { useAuthStore } from '../store/auth.store';

/**
 * Ожидающие подтверждения диалоги из `GET /api/v1/chat/pending`.
 *
 * Эндпоинт может отсутствовать в старом API: ошибка запроса не ломает
 * AI-Офис — интерфейс просто не показывает панель ожиданий.
 */
export function usePendingApprovals() {
  const accessToken = useAuthStore((state) => state.accessToken);

  return useQuery({
    queryKey: pendingApprovalsQueryKey,
    queryFn: fetchPendingApprovals,
    enabled: accessToken !== null,
    staleTime: 15_000,
    retry: false,
  });
}
