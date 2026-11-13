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
    const response = await fetch(`${this.baseUrl}/sse`, {
      headers: this.headers(),
      signal: controller.signal,
    });

    if (!response.ok || response.body === null) {
      throw new Error(`MCP SSE: HTTP ${response.status}`);
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

    await this.request(session, 'initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: this.clientName,
        version: this.clientVersion,
      },
    });
    await this.notify(session, 'notifications/initialized');

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
        this.failSession(
          session,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    } finally {
      if (!session.closed) {
        this.failSession(session, new Error('MCP SSE: поток закрыт'));
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
        reject(new Error(`MCP: таймаут вызова ${method}`));
      }, this.timeoutMs);

      session.pending.set(id, {
        resolve: (message) => {
          if (message.error !== undefined) {
            reject(new Error(`MCP ${method}: ${message.error.message}`));
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
        reject(error instanceof Error ? error : new Error(String(error)));
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
      throw new Error('MCP: endpoint ещё не получен');
    }

    const response = await fetch(session.endpoint, {
      method: 'POST',
      headers: {
        ...this.headers(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: session.controller.signal,
    });

    if (!response.ok) {
      throw new Error(`MCP POST: HTTP ${response.status}`);
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
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
