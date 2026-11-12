import { io, type Socket } from 'socket.io-client';
import { attachOfficeEventIngest } from './office-socket';

/**
 * Одно WebSocket-соединение на вкладку. Чат и AI-Офис слушают один и тот же
 * сокет, поэтому переход между страницами не рвёт поток событий агента.
 */
let socket: Socket | null = null;
let socketToken: string | null = null;

export function getSharedSocket(accessToken: string): Socket {
  if (socket !== null && socketToken === accessToken) {
    return socket;
  }

  socket?.disconnect();
  socketToken = accessToken;
  socket = io(window.location.origin, {
    path: '/socket.io',
    auth: { token: accessToken },
  });

  attachOfficeEventIngest(socket);

  return socket;
}

/** Вызывается при выходе из аккаунта: чужой сокет не должен остаться живым. */
export function disconnectSharedSocket(): void {
  socket?.disconnect();
  socket = null;
  socketToken = null;
}
