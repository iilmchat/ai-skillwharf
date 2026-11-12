import { isAxiosError } from 'axios';
import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { api } from '../lib/api';
import { useAuthStore } from '../store/auth.store';

const SOCKET_URL = import.meta.env.VITE_WS_URL ?? 'http://localhost:3001';
const ACK_TIMEOUT_MS = 90_000;
const INSUFFICIENT_FUNDS_MARKER = 'Недостаточно средств';

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
  connectionState: ConnectionState;
  setupError: string | null;
  notice: string | null;
  sendMessage: (content: string) => void;
  clearNotice: () => void;
  retry: () => void;
}

interface ChatReply {
  conversationId?: string;
  reply: string;
}

interface PendingReply {
  timeoutId: number;
  resolve: (reply: string) => void;
  reject: (error: Error) => void;
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

function getErrorMessage(error: unknown, fallback: string): string {
  if (isAxiosError(error)) {
    if (error.response === undefined) {
      return 'Сервер недоступен. Проверьте, что API запущен на localhost:3001.';
    }

    const data: unknown = error.response.data;

    if (isMessagePayload(data)) {
      return Array.isArray(data.message)
        ? data.message.join('; ')
        : data.message;
    }

    if (error.response.status === 401) {
      return 'Сессия истекла. Войдите заново.';
    }

    return fallback;
  }

  if (isMessagePayload(error)) {
    return Array.isArray(error.message)
      ? error.message.join('; ')
      : error.message;
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
  const [isSocketOnline, setIsSocketOnline] = useState(false);
  const [conversationError, setConversationError] = useState<string | null>(
    null,
  );
  const [socketError, setSocketError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const socketRef = useRef<Socket | null>(null);
  const pendingRef = useRef<PendingReply | null>(null);
  const conversationRequestedRef = useRef(false);

  const clearNotice = useCallback(() => setNotice(null), []);

  const retry = useCallback(() => {
    conversationRequestedRef.current = false;
    setNotice(null);
    setConversationError(null);
    setSocketError(null);
    setConversationId(null);
    setMessages([]);
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
      .post<{ id: string }>('/chat/conversations', { title: 'Новый диалог' })
      .then(({ data }) => {
        setConversationId(data.id);
      })
      .catch((error: unknown) => {
        setConversationError(
          getErrorMessage(error, 'Не удалось начать новый диалог.'),
        );
      });
  }, [accessToken, attempt]);

  // Socket.IO подключается с JWT в handshake.auth. Сервер сам проверяет
  // токен и отключает сокет при ошибке.
  useEffect(() => {
    if (accessToken === null) {
      return;
    }

    const socket = io(SOCKET_URL, { auth: { token: accessToken } });
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
        window.clearTimeout(pending.timeoutId);
        pendingRef.current = null;
        pending.reject(
          new Error('Соединение с чатом прервано. Попробуйте снова.'),
        );
      }

      setSocketError(
        reason === 'io server disconnect'
          ? 'Сервер отклонил подключение. Войдите заново или повторите попытку.'
          : 'Соединение с чатом потеряно. Переподключаемся…',
      );
    };

    const handleConnectError = () => {
      setIsSocketOnline(false);
      setSocketError(
        'Не удалось подключиться к чату. Проверьте, что API запущен на localhost:3001.',
      );
    };

    const handleException = (payload: unknown) => {
      const message = getErrorMessage(
        payload,
        'Не удалось отправить сообщение. Попробуйте ещё раз.',
      );
      const pending = pendingRef.current;

      if (pending !== null) {
        window.clearTimeout(pending.timeoutId);
        pendingRef.current = null;
        pending.reject(new Error(message));
        return;
      }

      setNotice(message);
    };

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('connect_error', handleConnectError);
    socket.on('exception', handleException);

    return () => {
      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('connect_error', handleConnectError);
      socket.off('exception', handleException);
      socket.disconnect();
      socketRef.current = null;
      setIsSocketOnline(false);

      const pending = pendingRef.current;

      if (pending !== null) {
        window.clearTimeout(pending.timeoutId);
        pendingRef.current = null;
      }
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
        setNotice(
          'Чат ещё не подключён. Подождите немного и попробуйте снова.',
        );
        return;
      }

      setMessages((current) => [
        ...current,
        { id: crypto.randomUUID(), role: 'user', content: trimmed },
      ]);
      setIsSending(true);
      setNotice(null);

      new Promise<string>((resolve, reject) => {
        const timeoutId = window.setTimeout(() => {
          pendingRef.current = null;
          reject(new Error('Сервер не ответил вовремя. Попробуйте снова.'));
        }, ACK_TIMEOUT_MS);

        pendingRef.current = {
          timeoutId,
          resolve: (reply) => {
            window.clearTimeout(timeoutId);
            resolve(reply);
          },
          reject: (error) => {
            window.clearTimeout(timeoutId);
            reject(error);
          },
        };

        socket.emit(
          'send_message',
          { conversationId, content: trimmed },
          (response: unknown) => {
            const pending = pendingRef.current;
            pendingRef.current = null;

            if (pending === null) {
              return;
            }

            if (isChatReply(response)) {
              pending.resolve(response.reply);
              return;
            }

            pending.reject(new Error('Сервер вернул некорректный ответ.'));
          },
        );
      })
        .then((reply) => {
          setMessages((current) => [
            ...current,
            { id: crypto.randomUUID(), role: 'assistant', content: reply },
          ]);

          // Paywall: сервер возвращает текст об ошибке обычным ответом.
          if (reply.includes(INSUFFICIENT_FUNDS_MARKER)) {
            setNotice(reply);
          }
        })
        .catch((error: unknown) => {
          setNotice(getErrorMessage(error, 'Не удалось отправить сообщение.'));
        })
        .finally(() => setIsSending(false));
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
    connectionState,
    setupError: conversationError ?? socketError,
    notice,
    sendMessage,
    clearNotice,
    retry,
  };
}
