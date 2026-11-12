import { useQuery } from '@tanstack/react-query';
import { fetchSkills } from '../lib/skills';
import { useAuthStore } from '../store/auth.store';

/** Ключ кэша навыков; используется для инвалидации после toggle. */
export const skillsQueryKey = ['skills'] as const;

export function useSkills() {
  const accessToken = useAuthStore((state) => state.accessToken);

  return useQuery({
    queryKey: skillsQueryKey,
    queryFn: fetchSkills,
    enabled: accessToken !== null,
    staleTime: 30_000,
  });
}
