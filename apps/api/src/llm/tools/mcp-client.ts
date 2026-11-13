/**
 * Минимальный MCP-клиент для HTTP/SSE транспорта. Сервер отдаёт поток
 * событий на `GET /sse`, первым событием присылает endpoint для POST, а
 * ответы на JSON-RPC возвращает сообщениями в том же потоке.
 */
export interface McpClientOptions {
  baseUrl: string;
  authToken?: string;
  timeoutMs?: number;
  clientName?: string;
  clientVersion?: string;
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
}

interface PendingRequest {
  resolve: (message: JsonRpcMessage) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface McpSession {
  controller: AbortController;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  pending: Map<number, PendingRequest>;
  endpoint: string | null;
  endpointResolve: (endpoint: string) => void;
  endpointReject: (error: Error) => void;
  closed: boolean;
}

/**
 * Ошибка транспорта: сеть недоступна, HTTP-ответ не успешен или поток SSE
 * прерван. `transient` говорит, имеет ли смысл повторять вызов: сетевые сбои
 * и HTTP 5xx временные, HTTP 4xx (например, 401/403) — нет.
 */
export class McpTransportError extends Error {
  /** HTTP-статус, если ошибка пришла на уровне HTTP. */
  readonly statusCode: number | undefined;

  /** Временная ли ошибка: сеть или HTTP >= 500. */
  readonly transient: boolean;

  constructor(message: string, options: { statusCode?: number } = {}) {
    super(message);
    this.name = 'McpTransportError';
    this.statusCode = options.statusCode;
    this.transient =
      options.statusCode === undefined || options.statusCode >= 500;
  }
}

/** Ошибка, которую MCP-сервер вернул в JSON-RPC-ответе. */
export class McpProviderError extends Error {
  /** Код ошибки JSON-RPC (например, -32602). */
  readonly rpcCode: number;

  constructor(message: string, options: { rpcCode: number }) {
    super(message);
    this.name = 'McpProviderError';
    this.rpcCode = options.rpcCode;
  }
}

/** Таймаут ожидания MCP-сервера (endpoint, ответ на запрос, поток). */
export class McpTimeoutError extends Error {
  /** Сколько миллисекунд ждали ответ. */
  readonly timeoutMs: number;

  constructor(message: string, options: { timeoutMs: number }) {
    super(message);
    this.name = 'McpTimeoutError';
    this.timeoutMs = options.timeoutMs;
  }
}

/**
 * Текст внешней ошибки уходит клиенту в `message`, поэтому вырезаем из него
 * похожие на секреты фрагменты (токены, `Authorization`) и ограничиваем
 * длину. Тела запросов и заголовки в сообщения не попадают вовсе.
 */
function safeDetail(message: string): string {
  return message
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(
      /((?:auth[-_]?token|api[-_]?key|client[-_]?secret|authorization|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi,
      '$1[REDACTED]',
    )
    .slice(0, 200);
}

/** Оборачивает сетевой сбой `fetch` в типизированную ошибку транспорта. */
function transportError(stage: string, error: unknown): McpTransportError {
  const detail = error instanceof Error ? error.message : String(error);

  return new McpTransportError(`${stage}: ошибка сети (${safeDetail(detail)})`);
}

/** Сохраняет типизированную ошибку как есть, остальное считает транспортом. */
function asMcpError(
  stage: string,
  error: unknown,
): McpTransportError | McpProviderError | McpTimeoutError {
  if (
    error instanceof McpTransportError ||
    error instanceof McpProviderError ||
    error instanceof McpTimeoutError
  ) {
    return error;
  }

  return transportError(stage, error);
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MCP_PROTOCOL_VERSION = '2024-11-05';

export class McpClient {
  private readonly baseUrl: string;
  private readonly authToken?: string;
  private readonly timeoutMs: number;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private session: McpSession | null = null;
  private connecting: Promise<McpSession> | null = null;
  private nextId = 1;

  constructor(options: McpClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.authToken = options.authToken;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.clientName = options.clientName ?? 'skillwharf-gateway';
    this.clientVersion = options.clientVersion ?? '0.1.0';
  }

  /** Вызывает MCP-инструмент и возвращает текстовый результат. */
  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const session = await this.connect();
    const result = await this.request(session, 'tools/call', {
      name,
      arguments: args,
    });

    return formatToolResult(result);
  }

  /** Закрывает SSE-сессию (нужно для тестов и graceful shutdown). */
  close(): void {
    const session = this.session;

    if (session === null) {
      return;
    }

    session.closed = true;
    session.controller.abort();
    this.session = null;
  }

  private async connect(): Promise<McpSession> {
    if (this.session !== null && !this.session.closed) {
      return this.session;
    }

    if (this.connecting !== null) {
      return this.connecting;
    }

    this.connecting = this.openSession().finally(() => {
      this.connecting = null;
    });

    return this.connecting;
  }

  private async openSession(): Promise<McpSession> {
    const controller = new AbortController();
    let response: Response;

    try {
      response = await fetch(`${this.baseUrl}/sse`, {
        headers: this.headers(),
        signal: controller.signal,
      });
    } catch (error) {
      throw transportError('MCP SSE', error);
    }

    if (!response.ok) {
      throw new McpTransportError(`MCP SSE: HTTP ${response.status}`, {
        statusCode: response.status,
      });
    }

    if (response.body === null) {
      throw new McpTransportError('MCP SSE: пустой поток');
    }

    let endpointResolve: (endpoint: string) => void = () => undefined;
    let endpointReject: (error: Error) => void = () => undefined;
    const endpointPromise = new Promise<string>((resolve, reject) => {
      endpointResolve = resolve;
      endpointReject = reject;
    });

    const session: McpSession = {
      controller,
      reader: response.body.getReader(),
      pending: new Map(),
      endpoint: null,
      endpointResolve,
      endpointReject,
      closed: false,
    };

    void this.readLoop(session);

    const endpoint = await withTimeout(
      endpointPromise,
      this.timeoutMs,
      'MCP SSE: не получен endpoint',
    );

    session.endpoint = new URL(endpoint, `${this.baseUrl}/`).toString();

    try {
      await this.request(session, 'initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: this.clientName,
          version: this.clientVersion,
        },
      });
      await this.notify(session, 'notifications/initialized');
    } catch (error) {
      // Неудачный initialize не должен оставлять висеть SSE-поток: повторный
      // вызов откроет новую сессию.
      session.closed = true;
      session.controller.abort();
      throw error;
    }

    this.session = session;

    return session;
  }

  private async readLoop(session: McpSession): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (!session.closed) {
        const { value, done } = await session.reader.read();

        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        let match = /\r?\n\r?\n/.exec(buffer);

        while (match !== null) {
          const block = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          this.handleEvent(session, block);
          match = /\r?\n\r?\n/.exec(buffer);
        }
      }
    } catch (error) {
      if (!session.closed) {
        this.failSession(session, asMcpError('MCP SSE', error));
      }
    } finally {
      if (!session.closed) {
        this.failSession(
          session,
          new McpTransportError('MCP SSE: поток закрыт'),
        );
      }
    }
  }

  private handleEvent(session: McpSession, block: string): void {
    let event = 'message';
    const dataLines: string[] = [];

    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) {
        event = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trimStart());
      }
    }

    const data = dataLines.join('\n');

    if (data === '') {
      return;
    }

    if (event === 'endpoint') {
      session.endpointResolve(data);
      return;
    }

    let message: JsonRpcMessage;

    try {
      message = JSON.parse(data) as JsonRpcMessage;
    } catch {
      return;
    }

    if (typeof message.id !== 'number') {
      return;
    }

    const pending = session.pending.get(message.id);

    if (pending === undefined) {
      return;
    }

    clearTimeout(pending.timer);
    session.pending.delete(message.id);
    pending.resolve(message);
  }

  private async request(
    session: McpSession,
    method: string,
    params: unknown,
  ): Promise<unknown> {
    const id = this.nextId;
    this.nextId += 1;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(id);
        reject(
          new McpTimeoutError(`MCP: таймаут вызова ${method}`, {
            timeoutMs: this.timeoutMs,
          }),
        );
      }, this.timeoutMs);

      session.pending.set(id, {
        resolve: (message) => {
          if (message.error !== undefined) {
            reject(
              new McpProviderError(
                `MCP ${method}: ${safeDetail(message.error.message)}`,
                { rpcCode: message.error.code },
              ),
            );
            return;
          }

          resolve(message.result);
        },
        reject,
        timer,
      });

      void this.post(session, {
        jsonrpc: '2.0',
        id,
        method,
        params,
      }).catch((error: unknown) => {
        clearTimeout(timer);
        session.pending.delete(id);
        reject(asMcpError('MCP POST', error));
      });
    });
  }

  private async notify(session: McpSession, method: string): Promise<void> {
    await this.post(session, { jsonrpc: '2.0', method });
  }

  private async post(
    session: McpSession,
    payload: JsonRpcMessage,
  ): Promise<void> {
    if (session.endpoint === null) {
      throw new McpTransportError('MCP: endpoint ещё не получен');
    }

    let response: Response;

    try {
      response = await fetch(session.endpoint, {
        method: 'POST',
        headers: {
          ...this.headers(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: session.controller.signal,
      });
    } catch (error) {
      throw transportError('MCP POST', error);
    }

    if (!response.ok) {
      throw new McpTransportError(`MCP POST: HTTP ${response.status}`, {
        statusCode: response.status,
      });
    }
  }

  private failSession(session: McpSession, error: Error): void {
    session.closed = true;
    session.endpointReject(error);

    for (const pending of session.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }

    session.pending.clear();

    if (this.session === session) {
      this.session = null;
    }
  }

  private headers(): Record<string, string> {
    return this.authToken === undefined
      ? { Accept: 'text/event-stream' }
      : {
          Accept: 'text/event-stream',
          Authorization: `Bearer ${this.authToken}`,
        };
  }
}

function formatToolResult(result: unknown): string {
  if (typeof result === 'string') {
    return result;
  }

  if (typeof result === 'object' && result !== null) {
    const content = (result as { content?: unknown }).content;

    if (Array.isArray(content)) {
      const parts = content
        .map((item) => {
          if (
            typeof item === 'object' &&
            item !== null &&
            'text' in item &&
            typeof item.text === 'string'
          ) {
            return item.text;
          }

          return JSON.stringify(item);
        })
        .filter((part): part is string => part.length > 0);

      if (parts.length > 0) {
        return parts.join('\n');
      }
    }
  }

  return JSON.stringify(result);
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new McpTimeoutError(message, { timeoutMs })),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
