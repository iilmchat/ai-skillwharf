import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

export const WORKSPACE_STORAGE_KEY = 'skillwharf-workspace';

interface WorkspaceState {
  /** Явно выбранный пользователем воркспейс; `null` — серверный default. */
  activeWorkspaceId: string | null;
  setActiveWorkspace: (workspaceId: string | null) => void;
  reset: () => void;
}

/**
 * Активный воркспейс переживает F5. Заголовок `X-Workspace-Id` ставится
 * request-интерцептором HTTP-клиента из этого же состояния.
 */
export const useWorkspaceStore = create<WorkspaceState>()(
  persist(
    (set) => ({
      activeWorkspaceId: null,
      setActiveWorkspace: (activeWorkspaceId) => set({ activeWorkspaceId }),
      reset: () => set({ activeWorkspaceId: null }),
    }),
    {
      name: WORKSPACE_STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        activeWorkspaceId: state.activeWorkspaceId,
      }),
    },
  ),
);
