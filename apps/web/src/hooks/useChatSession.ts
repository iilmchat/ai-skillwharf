import { isAxiosError } from 'axios';
import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import i18n from '../i18n';
import { api } from '../lib/api';
import { useAuthStore } from '../store/auth.store';

const ACK_TIMEOUT_MS = 90_000;
const INSUFFICIENT_FUNDS_MARKER = 'Недостаточно средств';
const ERROR_KEY_PREFIX = 'errors.';

export type ChatRole = 'user' | 'assistant';
export type ConnectionState = 'connecting' | 'online' | 'offline';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
}

export interface ChatSession {
  messages: ChatMessage[];
  conversationId: string | null;
  isReady: boolean;
  isSending: boolean;
  isStreaming: boolean;
  connectionState: ConnectionState;
  setupError: string | null;
  notice: string | null;
  noticeTopUp: boolean;
  sendMessage: (content: string) => void;
  clearNotice: () => void;
  retry: () => void;
}

interface ChatReply {
  conversationId?: string;
  reply: string;
}

interface PendingReply {
  /** `null` — ответ пришёл потоком и уже добавлен в стейт. */
  resolve: (reply: string | null) => void;
  reject: (error: Error) => void;
  /** Продлевает ожидание: стрим может идти дольше одного ack-таймаута. */
  refresh: () => void;
  /** Отмена без reject — например, при размонтировании компонента. */
  cancel: () => void;
}

interface StreamDelta {
  text: string;
  conversationId?: string;
}

interface MessagePayload {
  message: string | string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isMessagePayload(value: unknown): value is MessagePayload {
  if (!isRecord(value) || !('message' in value)) {
    return false;
  }

  const { message } = value;

  return (
    typeof message === 'string' ||
    (Array.isArray(message) &&
      message.every((item): item is string => typeof item === 'string'))
  );
}

function isChatReply(value: unknown): value is ChatReply {
  return isRecord(value) && 'reply' in value && typeof value.reply === 'string';
}

/** Идентификатор диалога в payload события, если он там есть. */
function getPayloadConversationId(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.conversationId !== 'string') {
    return undefined;
  }

  return value.conversationId;
}

/**
 * Текст дельты из события `stream_delta`. Бэкенд может называть поле
 * `delta`, `text`, `content` или `chunk` — принимаем любой из вариантов.
 */
function parseStreamDelta(value: unknown): StreamDelta | null {
  if (typeof value === 'string') {
    return value === '' ? null : { text: value };
  }

  if (!isRecord(value)) {
    return null;
  }

  const text = value.delta ?? value.text ?? value.content ?? value.chunk;

  if (typeof text !== 'string' || text === '') {
    return null;
  }

  return { text, conversationId: getPayloadConversationId(value) };
}

/** Бэкенд может вернуть ключ ошибки (`errors.*`) вместо готового текста. */
function translateServerMessage(message: string): string {
  return message.startsWith(ERROR_KEY_PREFIX) && i18n.exists(message)
    ? i18n.t(message)
    : message;
}

function formatServerMessage(message: string | string[]): string {
  return Array.isArray(message)
    ? message.map(translateServerMessage).join('; ')
    : translateServerMessage(message);
}

interface NormalizedReply {
  content: string;
  notice: string | null;
  needsTopUp: boolean;
}

function hasInsufficientFundsMessage(message: string): boolean {
  return (
    message === 'errors.insufficient_funds' ||
    message.includes(INSUFFICIENT_FUNDS_MARKER)
  );
}

function isInsufficientFundsPayload(payload: unknown): boolean {
  if (!isRecord(payload) || !('message' in payload)) {
    return false;
  }

  const { message } = payload;

  if (typeof message === 'string') {
    return hasInsufficientFundsMessage(message);
  }

  return (
    Array.isArray(message) &&
    message.some(
      (item): boolean =>
        typeof item === 'string' && hasInsufficientFundsMessage(item),
    )
  );
}

function normalizeAssistantReply(reply: string): NormalizedReply {
  const needsTopUp = hasInsufficientFundsMessage(reply);

  if (reply.startsWith(ERROR_KEY_PREFIX)) {
    const content = i18n.exists(reply)
      ? i18n.t(reply)
      : i18n.t('chat.errors.messageFailed');

    return { content, notice: content, needsTopUp };
  }

  // Совместимость со старым ответом бэкенда, где текст был захардкожен.
  if (reply.includes(INSUFFICIENT_FUNDS_MARKER)) {
    return {
      content: reply,
      notice: i18n.t('chat.errors.insufficientFunds'),
      needsTopUp: true,
    };
  }

  return { content: reply, notice: null, needsTopUp };
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (isAxiosError(error)) {
    if (error.response === undefined) {
      return i18n.t('chat.errors.network');
    }

    if (error.response.status === 401) {
      return i18n.t('chat.errors.expired');
    }

    const data: unknown = error.response.data;

    if (isMessagePayload(data)) {
      return formatServerMessage(data.message);
    }

    return fallback;
  }

  if (isMessagePayload(error)) {
    return formatServerMessage(error.message);
  }

  if (error instanceof Error && error.message !== '') {
    return error.message;
  }

  return fallback;
}

export function useChatSession(): ChatSession {
  const accessToken = useAuthStore((state) => state.accessToken);

  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isSocketOnline, setIsSocketOnline] = useState(false);
  const [conversationError, setConversationError] = useState<string | null>(
    null,
  );
  const [socketError, setSocketError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeTopUp, setNoticeTopUp] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const socketRef = useRef<Socket | null>(null);
  const pendingRef = useRef<PendingReply | null>(null);
  const pendingTopUpRef = useRef(false);
  const conversationRequestedRef = useRef(false);
  const conversationIdRef = useRef<string | null>(null);
  const streamMessageIdRef = useRef<string | null>(null);
  const streamedTextRef = useRef('');

  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  const clearNotice = useCallback(() => {
    setNotice(null);
    setNoticeTopUp(false);
  }, []);

  const retry = useCallback(() => {
    conversationRequestedRef.current = false;
    streamMessageIdRef.current = null;
    streamedTextRef.current = '';
    setNotice(null);
    setNoticeTopUp(false);
    setConversationError(null);
    setSocketError(null);
    setConversationId(null);
    setMessages([]);
    setIsStreaming(false);
    setAttempt((value) => value + 1);
  }, []);

  // Диалог создаётся один раз при входе на страницу. Ref переживает двойной
  // запуск эффектов в StrictMode, поэтому лишний диалог в БД не создаётся.
  useEffect(() => {
    if (accessToken === null || conversationRequestedRef.current) {
      return;
    }

    conversationRequestedRef.current = true;
    setConversationError(null);
    setConversationId(null);

    api
      .post<{ id: string }>('/chat/conversations', {
        title: i18n.t('chat.newConversation'),
      })
      .then(({ data }) => {
        setConversationId(data.id);
      })
      .catch((error: unknown) => {
        setConversationError(
          getErrorMessage(error, i18n.t('chat.errors.conversationFailed')),
        );
      });
  }, [accessToken, attempt]);

  // Socket.IO идёт на тот же origin: в dev его проксирует Vite,
  // в production — reverse proxy (Caddy/Nginx). Это убирает CORS
  // и хардкод адреса API.
  useEffect(() => {
    if (accessToken === null) {
      return;
    }

    const socket = io(window.location.origin, {
      path: '/socket.io',
      auth: { token: accessToken },
    });
    socketRef.current = socket;

    const handleConnect = () => {
      setIsSocketOnline(true);
      setSocketError(null);
    };

    const handleDisconnect = (reason: string) => {
      setIsSocketOnline(false);

      if (reason === 'io client disconnect') {
        return;
      }

      const pending = pendingRef.current;

      if (pending !== null) {
        pendingTopUpRef.current = false;
        pending.reject(new Error(i18n.t('chat.errors.disconnected')));
      }

      streamMessageIdRef.current = null;
      streamedTextRef.current = '';
      setIsStreaming(false);

      setSocketError(
        reason === 'io server disconnect'
          ? i18n.t('chat.errors.connectionRejected')
          : i18n.t('chat.errors.connectionLost'),
      );
    };

    const handleConnectError = () => {
      setIsSocketOnline(false);
      setSocketError(i18n.t('chat.errors.connectionFailed'));
    };

    const handleException = (payload: unknown) => {
      const message = getErrorMessage(
        payload,
        i18n.t('chat.errors.messageFailed'),
      );
      const needsTopUp = isInsufficientFundsPayload(payload);
      const pending = pendingRef.current;

      if (pending !== null) {
        pendingTopUpRef.current = needsTopUp;
        pending.reject(new Error(message));
        return;
      }

      setNotice(message);
      setNoticeTopUp(needsTopUp);
    };

    const handleStreamDelta = (payload: unknown) => {
      const pending = pendingRef.current;
      const delta = parseStreamDelta(payload);

      if (pending === null || delta === null) {
        return;
      }

      const activeConversationId = conversationIdRef.current;

      if (
        delta.conversationId !== undefined &&
        delta.conversationId !== activeConversationId
      ) {
        return;
      }

      // Стрим может быть длиннее ack-таймаута — продлеваем ожидание.
      pending.refresh();
      streamedTextRef.current += delta.text;

      const streamMessageId = streamMessageIdRef.current;

      if (streamMessageId === null) {
        const messageId = crypto.randomUUID();

        streamMessageIdRef.current = messageId;
        setIsStreaming(true);
        setMessages((current) => [
          ...current,
          { id: messageId, role: 'assistant', content: delta.text },
        ]);
        return;
      }

      setMessages((current) =>
        current.map((message) =>
          message.id === streamMessageId
            ? { ...message, content: message.content + delta.text }
            : message,
        ),
      );
    };

    const handleStreamEnd = (payload: unknown) => {
      const pending = pendingRef.current;
      const eventConversationId = getPayloadConversationId(payload);

      if (
        eventConversationId !== undefined &&
        eventConversationId !== conversationIdRef.current
      ) {
        return;
      }

      setIsStreaming(false);

      if (pending !== null) {
        // Поток уже отрисован в стейте; ack с полным текстом больше не нужен.
        pending.resolve(null);
      }
    };

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('connect_error', handleConnectError);
    socket.on('exception', handleException);
    socket.on('stream_delta', handleStreamDelta);
    socket.on('stream_end', handleStreamEnd);

    return () => {
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('connect_error', handleConnectError);
      socket.off('exception', handleException);
      socket.off('stream_delta', handleStreamDelta);
      socket.off('stream_end', handleStreamEnd);
      socket.disconnect();
      socketRef.current = null;
      setIsSocketOnline(false);

      pendingRef.current?.cancel();
      pendingRef.current = null;
      streamMessageIdRef.current = null;
      streamedTextRef.current = '';
    };
  }, [accessToken, attempt]);

  const sendMessage = useCallback(
    (content: string) => {
      const trimmed = content.trim();
      const socket = socketRef.current;

      if (trimmed === '' || pendingRef.current !== null) {
        return;
      }

      if (conversationId === null || socket === null || !socket.connected) {
        setNotice(i18n.t('chat.errors.notReady'));
        setNoticeTopUp(false);
        return;
      }

      setMessages((current) => [
        ...current,
        { id: crypto.randomUUID(), role: 'user', content: trimmed },
      ]);
      setIsSending(true);
      setIsStreaming(false);
      streamMessageIdRef.current = null;
      streamedTextRef.current = '';
      setNotice(null);
      setNoticeTopUp(false);
      pendingTopUpRef.current = false;

      new Promise<string | null>((resolve, reject) => {
        let timeoutId = 0;

        const handleTimeout = () => {
          pendingRef.current = null;
          reject(new Error(i18n.t('chat.errors.timeout')));
        };

        const clearTimer = () => window.clearTimeout(timeoutId);

        const settle = (callback: () => void) => {
          clearTimer();
          pendingRef.current = null;
          callback();
        };

        const armTimer = () => {
          clearTimer();
          timeoutId = window.setTimeout(handleTimeout, ACK_TIMEOUT_MS);
        };

        armTimer();

        pendingRef.current = {
          resolve: (reply) => settle(() => resolve(reply)),
          reject: (error) => settle(() => reject(error)),
          refresh: armTimer,
          cancel: () => {
            clearTimer();
            pendingRef.current = null;
          },
        };

        socket.emit(
          'send_message',
          { conversationId, content: trimmed },
          (response: unknown) => {
            const pending = pendingRef.current;

            if (pending === null) {
              return;
            }

            // Уже пришли `stream_delta`: полный ответ в ack — дубль.
            if (streamMessageIdRef.current !== null) {
              return;
            }

            if (isChatReply(response)) {
              pending.resolve(response.reply);
              return;
            }

            pending.reject(new Error(i18n.t('chat.errors.invalidResponse')));
          },
        );
      })
        .then((reply) => {
          // `null` — текст уже отрисован из событий `stream_delta`.
          if (reply === null) {
            const streamedText = streamedTextRef.current;
            const normalized = normalizeAssistantReply(streamedText);
            const messageId = streamMessageIdRef.current;

            // Служебные ответы вроде `errors.insufficient_funds` приходят
            // потоком как обычный текст — переводим их и показываем notice.
            if (messageId !== null && normalized.content !== streamedText) {
              setMessages((current) =>
                current.map((message) =>
                  message.id === messageId
                    ? { ...message, content: normalized.content }
                    : message,
                ),
              );
            }

            if (normalized.notice !== null) {
              setNotice(normalized.notice);
            }

            setNoticeTopUp(normalized.needsTopUp);
            return;
          }

          const normalized = normalizeAssistantReply(reply);

          setMessages((current) => [
            ...current,
            {
              id: crypto.randomUUID(),
              role: 'assistant',
              content: normalized.content,
            },
          ]);

          if (normalized.notice !== null) {
            setNotice(normalized.notice);
          }

          setNoticeTopUp(normalized.needsTopUp);
        })
        .catch((error: unknown) => {
          const needsTopUp = pendingTopUpRef.current;
          pendingTopUpRef.current = false;

          setNotice(getErrorMessage(error, i18n.t('chat.errors.sendFailed')));
          setNoticeTopUp(needsTopUp);
        })
        .finally(() => {
          setIsSending(false);
          setIsStreaming(false);
          streamMessageIdRef.current = null;
          streamedTextRef.current = '';
        });
    },
    [conversationId],
  );

  const isReady = conversationId !== null && isSocketOnline;
  const connectionState: ConnectionState = isSocketOnline
    ? 'online'
    : socketError !== null
      ? 'offline'
      : 'connecting';

  return {
    messages,
    conversationId,
    isReady,
    isSending,
    isStreaming,
    connectionState,
    setupError: conversationError ?? socketError,
    notice,
    noticeTopUp,
    sendMessage,
    clearNotice,
    retry,
  };
}
