import { useQuery } from '@tanstack/react-query';
import { activeLlmQueryKey, fetchActiveLlm } from '../lib/llm';
import { useAuthStore } from '../store/auth.store';

/** Активный LLM-маршрут: провайдер и модель для шапки чата. */
export function useActiveLlm() {
  const accessToken = useAuthStore((state) => state.accessToken);

  return useQuery({
    queryKey: activeLlmQueryKey,
    queryFn: fetchActiveLlm,
    enabled: accessToken !== null,
    staleTime: 60_000,
    retry: false,
  });
}
