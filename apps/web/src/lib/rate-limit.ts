import { create } from 'zustand';

interface RateLimitState {
  /** Растёт при каждом ответе 429: тост перезапускается. */
  signal: number;
  notify: () => void;
  clear: () => void;
}

/** Глобальный сигнал «слишком много запросов» для тоста поверх любого экрана. */
export const useRateLimitStore = create<RateLimitState>((set) => ({
  signal: 0,
  notify: () => set((state) => ({ signal: state.signal + 1 })),
  clear: () => set({ signal: 0 }),
}));
