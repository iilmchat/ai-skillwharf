import {
  McpClient,
  McpProviderError,
  McpTimeoutError,
  McpTransportError,
} from './mcp-client.js';

type FetchMock = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

interface JsonRpcRequest {
  id?: number;
  method: string;
}

const encoder = new TextEncoder();

/** Ответ MCP-сервера с результатом JSON-RPC. */
function rpcResult(id: number | undefined, result: unknown): unknown {
  return { jsonrpc: '2.0', id, result };
}

/** Ответ MCP-сервера с ошибкой JSON-RPC. */
function rpcError(
  id: number | undefined,
  code: number,
  message: string,
): unknown {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/**
 * Имитация MCP-сервера: на GET /sse отдаёт поток с endpoint, на POST —
 * кладёт JSON-RPC-ответ в тот же поток, как настоящий MCP.
 */
function createMcpFetchMock(
  replyFor: (request: JsonRpcRequest) => unknown,
): FetchMock {
  let streamController: ReadableStreamDefaultController<Uint8Array> | null =
    null;

  const pushFrame = (frame: string): void => {
    streamController?.enqueue(encoder.encode(frame));
  };

  return async (input, init) => {
    if (init?.method === 'POST') {
      if (typeof init.body !== 'string') {
        throw new Error('ожидалось строковое тело JSON-RPC-запроса');
      }

      const request = JSON.parse(init.body) as JsonRpcRequest;
      const reply = replyFor(request);

      if (reply !== undefined) {
        pushFrame(`data: ${JSON.stringify(reply)}\n\n`);
      }

      return new Response(null, { status: 202 });
    }

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(
          encoder.encode('event: endpoint\ndata: /messages\n\n'),
        );
      },
    });

    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;

    expect(url).toBe('http://mcp.local/sse');

    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  };
}

/** Достаёт брошенную ошибку, не роняя тест на неожиданном успехе. */
async function captureError(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('ожидалась ошибка, но вызов завершился успешно');
    },
    (reason: unknown) => reason,
  );
}

describe('McpClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('передаёт Authorization: Bearer, если задан authToken', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('stop'));
    vi.stubGlobal('fetch', fetchMock);

    const client = new McpClient({
      baseUrl: 'http://mcp.local',
      authToken: 'secret-token',
    });

    await expect(client.callTool('ping', {})).rejects.toThrow('stop');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://mcp.local/sse',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer secret-token',
        }),
      }),
    );
  });

  it('не добавляет Authorization, если токен не задан', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('stop'));
    vi.stubGlobal('fetch', fetchMock);

    const client = new McpClient({ baseUrl: 'http://mcp.local' });

    await expect(client.callTool('ping', {})).rejects.toThrow('stop');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://mcp.local/sse',
      expect.objectContaining({
        headers: { Accept: 'text/event-stream' },
      }),
    );
  });

  it('оборачивает сетевой сбой в McpTransportError (transient)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    const client = new McpClient({ baseUrl: 'http://mcp.local' });
    const error = await captureError(client.callTool('ping', {}));

    expect(error).toBeInstanceOf(McpTransportError);
    expect((error as McpTransportError).transient).toBe(true);
    expect((error as McpTransportError).statusCode).toBeUndefined();
    expect((error as McpTransportError).message).toContain('network down');
  });

  it('оборачивает HTTP 5xx в McpTransportError с transient=true', async () => {
    const fetchMock = vi.fn<FetchMock>(
      async () => new Response(null, { status: 503 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new McpClient({ baseUrl: 'http://mcp.local' });
    const error = await captureError(client.callTool('ping', {}));

    expect(error).toBeInstanceOf(McpTransportError);
    expect((error as McpTransportError).statusCode).toBe(503);
    expect((error as McpTransportError).transient).toBe(true);
  });

  it('оборачивает HTTP 4xx в McpTransportError с transient=false', async () => {
    const fetchMock = vi.fn<FetchMock>(
      async () => new Response(null, { status: 401 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new McpClient({ baseUrl: 'http://mcp.local' });
    const error = await captureError(client.callTool('ping', {}));

    expect(error).toBeInstanceOf(McpTransportError);
    expect((error as McpTransportError).statusCode).toBe(401);
    expect((error as McpTransportError).transient).toBe(false);
  });

  it('отдаёт McpTimeoutError, если endpoint не пришёл за timeoutMs', async () => {
    const fetchMock = vi.fn<FetchMock>(
      async () =>
        new Response(new ReadableStream<Uint8Array>(), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new McpClient({
      baseUrl: 'http://mcp.local',
      timeoutMs: 10,
    });
    const error = await captureError(client.callTool('ping', {}));

    expect(error).toBeInstanceOf(McpTimeoutError);
    expect((error as McpTimeoutError).timeoutMs).toBe(10);
  });

  it('отдаёт McpTransportError, если поток SSE закрылся до endpoint', async () => {
    const fetchMock = vi.fn<FetchMock>(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      });

      return new Response(stream, { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new McpClient({
      baseUrl: 'http://mcp.local',
      timeoutMs: 500,
    });
    const error = await captureError(client.callTool('ping', {}));

    expect(error).toBeInstanceOf(McpTransportError);
  });

  it('оборачивает JSON-RPC error в McpProviderError и маскирует токен', async () => {
    const fetchMock = vi.fn<FetchMock>(
      createMcpFetchMock((request) => {
        if (request.method === 'initialize') {
          return rpcResult(request.id, {});
        }

        if (request.method === 'tools/call') {
          return rpcError(
            request.id,
            -32602,
            'invalid params: Bearer super-secret-token',
          );
        }

        return undefined;
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const client = new McpClient({
      baseUrl: 'http://mcp.local',
      timeoutMs: 1_000,
    });

    try {
      const error = await captureError(client.callTool('ping', {}));

      expect(error).toBeInstanceOf(McpProviderError);
      expect((error as McpProviderError).rpcCode).toBe(-32602);
      expect((error as McpProviderError).message).not.toContain(
        'super-secret-token',
      );
      expect((error as McpProviderError).message).toContain('[REDACTED]');
    } finally {
      client.close();
    }
  });
});
