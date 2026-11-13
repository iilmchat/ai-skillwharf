import { useQuery } from '@tanstack/react-query';
import { RAG_MEMORY_PANEL_ENABLED } from '../lib/feature-flags';
import { fetchMemoryEntries, ragMemoryQueryKey } from '../lib/rag-memory';
import { useAuthStore } from '../store/auth.store';

/**
 * Записи RAG-памяти из `GET /api/v1/chat/memory`.
 *
 * Запрос выполняется только при включённом feature-флаге и живой сессии:
 * пока эндпоинта нет (KI-023), раздел скрыт и в сеть не ходит.
 */
export function useRagMemory() {
  const accessToken = useAuthStore((state) => state.accessToken);

  return useQuery({
    queryKey: ragMemoryQueryKey,
    queryFn: fetchMemoryEntries,
    enabled: RAG_MEMORY_PANEL_ENABLED && accessToken !== null,
    staleTime: 30_000,
    retry: false,
  });
}
