import { create } from 'zustand';
import type { OfficeEvent } from '../lib/office-events';

export type OfficeLiveEvent = Omit<OfficeEvent, 'conversationId'> & {
  conversationId: string | null;
  receivedAt: number;
};

interface OfficeState {
  /** Диалог, к которому привязаны события офиса. */
  conversationId: string | null;
  /** Последнее событие агента — переживает переход между страницами. */
  lastEvent: OfficeLiveEvent | null;
  setConversationId: (conversationId: string | null) => void;
  pushEvent: (
    event: OfficeEvent,
    fallbackConversationId?: string | null,
  ) => void;
  reset: () => void;
}

export const useOfficeStore = create<OfficeState>((set) => ({
  conversationId: null,
  lastEvent: null,

  setConversationId: (conversationId) => set({ conversationId }),

  pushEvent: (event, fallbackConversationId = null) =>
    set((state) => {
      const conversationId =
        event.conversationId ??
        state.conversationId ??
        fallbackConversationId;

      return {
        conversationId: conversationId ?? state.conversationId,
        lastEvent: {
          ...event,
          conversationId,
          receivedAt: Date.now(),
        },
      };
    }),

  reset: () => set({ conversationId: null, lastEvent: null }),
}));

/** Императивная запись события из socket-обработчиков вне React. */
export function pushOfficeEvent(
  event: OfficeEvent,
  fallbackConversationId: string | null = null,
): void {
  useOfficeStore.getState().pushEvent(event, fallbackConversationId);
}
