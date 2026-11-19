import { create } from 'zustand';
import type { OfficeEvent, OfficeHandoff } from '../lib/office-events';

export type OfficeLiveEvent = Omit<OfficeEvent, 'conversationId'> & {
  conversationId: string | null;
  receivedAt: number;
};

export interface OfficeHandoffRecord extends OfficeHandoff {
  conversationId: string | null;
  receivedAt: number;
}

const MAX_HANDOFFS = 8;

interface OfficeState {
  /** Диалог, к которому привязаны события офиса. */
  conversationId: string | null;
  /** Последнее событие агента — переживает переход между страницами. */
  lastEvent: OfficeLiveEvent | null;
  /** Компактная лента последних передач задач между ролями. */
  handoffs: OfficeHandoffRecord[];
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
  handoffs: [],

  setConversationId: (conversationId) => set({ conversationId }),

  pushEvent: (event, fallbackConversationId = null) =>
    set((state) => {
      const conversationId =
        event.conversationId ??
        state.conversationId ??
        fallbackConversationId;
      const receivedAt = Date.now();

      return {
        conversationId: conversationId ?? state.conversationId,
        lastEvent: {
          ...event,
          conversationId,
          receivedAt,
        },
        ...(event.handoff === undefined
          ? {}
          : {
              handoffs: [
                { ...event.handoff, conversationId, receivedAt },
                ...state.handoffs,
              ].slice(0, MAX_HANDOFFS),
            }),
      };
    }),

  reset: () => set({ conversationId: null, lastEvent: null, handoffs: [] }),
}));

/** Императивная запись события из socket-обработчиков вне React. */
export function pushOfficeEvent(
  event: OfficeEvent,
  fallbackConversationId: string | null = null,
): void {
  useOfficeStore.getState().pushEvent(event, fallbackConversationId);
}
