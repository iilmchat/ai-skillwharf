import type { Socket } from 'socket.io-client';
import i18n from '../i18n';
import {
  DEFAULT_OFFICE_AGENT_ID,
  parseOfficeEvent,
  readConversationId,
} from './office-events';
import { pushOfficeEvent, useOfficeStore } from '../store/office.store';

/**
 * Единая точка приёма office-событий. Слушатели живут столько же, сколько
 * сокет, поэтому переход между чатом и офисом не теряет `stream_end`.
 */
export function attachOfficeEventIngest(socket: Socket): void {
  socket.on('office_event', (payload: unknown) => {
    const event = parseOfficeEvent(payload);

    if (event === null) {
      return;
    }

    const activeConversationId = useOfficeStore.getState().conversationId;

    if (
      event.conversationId !== undefined &&
      activeConversationId !== null &&
      event.conversationId !== activeConversationId
    ) {
      return;
    }

    pushOfficeEvent(event, activeConversationId);
  });

  socket.on('stream_end', (payload: unknown) => {
    const activeConversationId = useOfficeStore.getState().conversationId;
    const eventConversationId = readConversationId(payload);

    if (
      eventConversationId !== null &&
      activeConversationId !== null &&
      eventConversationId !== activeConversationId
    ) {
      return;
    }

    const conversationId = eventConversationId ?? activeConversationId;

    pushOfficeEvent(
      {
        agentId: DEFAULT_OFFICE_AGENT_ID,
        status: 'idle',
        task: i18n.t('office.tasks.finished'),
        conversationId: conversationId ?? undefined,
      },
      conversationId,
    );
  });
}
