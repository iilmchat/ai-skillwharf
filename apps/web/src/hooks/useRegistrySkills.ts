import { useQuery } from '@tanstack/react-query';
import { fetchRegistrySkills } from '../lib/registry';
import { useAuthStore } from '../store/auth.store';

/** Ключ кэша публичного реестра навыков. */
export const registrySkillsQueryKey = ['registry', 'skills'] as const;

export function useRegistrySkills() {
  const accessToken = useAuthStore((state) => state.accessToken);

  return useQuery({
    queryKey: registrySkillsQueryKey,
    queryFn: fetchRegistrySkills,
    enabled: accessToken !== null,
    staleTime: 30_000,
  });
}
