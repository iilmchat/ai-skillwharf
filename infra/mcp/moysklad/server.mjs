import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

/**
 * Минимальный MCP-сервер для МойСклад (JSON API 1.2).
 *
 * Транспорт: MCP HTTP/SSE (GET /sse + POST /messages), совместимый с
 * apps/api/src/agent/tools/mcp-client.ts. Инструменты вызывают реальные
 * методы JSON API 1.2 с Bearer-токеном.
 */

const PORT = Number.parseInt(process.env.PORT ?? '5004', 10);
const SERVICE_NAME = 'moysklad-mcp';
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN?.trim() ?? '';
const ALLOW_MISSING_KEYS = process.env.MCP_ALLOW_MISSING_KEYS === '1';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 1_048_576;
const PROTOCOL_VERSION = '2024-11-05';
const DEFAULT_BASE_URL = 'https://api.moysklad.ru/api/remap/1.2';
const MAX_TOOL_ATTEMPTS = 2;
const RETRY_BASE_DELAY_MS = 200;
const MOYSKLAD_TOKEN_HEADER = 'x-moysklad-token';

const token = process.env.MOYSKLAD_TOKEN?.trim() ?? '';
const baseUrlRaw = process.env.MOYSKLAD_BASE_URL?.trim() || DEFAULT_BASE_URL;
let baseUrl = null;

try {
  baseUrl = normalizeBaseUrl(baseUrlRaw);
} catch (error) {
  console.error(
    `${SERVICE_NAME}: MOYSKLAD_BASE_URL некорректен: ${safeDetail(
      error instanceof Error ? error.message : String(error),
    )}`,
  );
}

function isLocalHost(hostname) {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === 'host.docker.internal'
  );
}

function normalizeBaseUrl(raw) {
  const url = new URL(raw);

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('разрешены только http/https');
  }

  const local = isLocalHost(url.hostname);

  if (!local) {
    if (url.protocol !== 'https:') {
      throw new Error('внешний МойСклад API должен использовать https');
    }

    if (url.hostname !== 'moysklad.ru' && !url.hostname.endsWith('.moysklad.ru')) {
      throw new Error('base URL должен указывать на *.moysklad.ru');
    }
  }

  url.search = '';
  url.hash = '';

  return url.toString().replace(/\/+$/, '');
}

function safeDetail(value) {
  return String(value)
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(
      /((?:token|authorization|api[-_]?key|secret)\s*[:=]\s*)\S+/gi,
      '$1[REDACTED]',
    )
    .slice(0, 300);
}

function asObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('arguments должен быть объектом');
  }

  return value;
}

function headerValue(headers, name) {
  const value = headers[name];

  if (Array.isArray(value)) {
    return value[0] ?? '';
  }

  return typeof value === 'string' ? value : '';
}

/** Токен clients приходит в X-Moysklad-Token, иначе используется env. */
export function resolveMoyskladTokenFromHeaders(headers, fallback = token) {
  return headerValue(headers, MOYSKLAD_TOKEN_HEADER).trim() || fallback || '';
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** До двух попыток с экспоненциальной задержкой на 429/5xx и сетевых сбоях. */
async function fetchWithRetry(url, init, timeoutMs) {
  for (let attempt = 1; ; attempt += 1) {
    let response;

    try {
      response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (attempt >= MAX_TOOL_ATTEMPTS) {
        throw error;
      }
      await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      continue;
    }

    const retryable = response.status === 429 || response.status >= 500;

    if (!retryable || attempt >= MAX_TOOL_ATTEMPTS) {
      return response;
    }

    await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
  }
}

const TOOLS = [
  {
    name: 'product_list',
    description: 'Список товаров МойСклад (GET /entity/product).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        offset: { type: 'integer', minimum: 0 },
        filter: { type: 'string' },
        search: { type: 'string' },
        expand: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'product_get',
    description: 'Получить товар МойСклад по ID (GET /entity/product/{id}).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'stock_report',
    description: 'Остатки товаров МойСклад (GET /report/stock/all).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        offset: { type: 'integer', minimum: 0 },
        filter: { type: 'string' },
        search: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'customer_order_list',
    description: 'Список заказов покупателей (GET /entity/customerorder).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        offset: { type: 'integer', minimum: 0 },
        filter: { type: 'string' },
        search: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'customer_order_get',
    description: 'Получить заказ покупателя по ID (GET /entity/customerorder/{id}).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'customer_order_create',
    description: 'Создать заказ покупателя (POST /entity/customerorder).',
    inputSchema: {
      type: 'object',
      properties: { payload: { type: 'object' } },
      required: ['payload'],
      additionalProperties: false,
    },
  },
  {
    name: 'counterparty_list',
    description: 'Список контрагентов (GET /entity/counterparty).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        offset: { type: 'integer', minimum: 0 },
        filter: { type: 'string' },
        search: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'demand_create',
    description: 'Создать отгрузку покупателю (POST /entity/demand).',
    inputSchema: {
      type: 'object',
      properties: { payload: { type: 'object' } },
      required: ['payload'],
      additionalProperties: false,
    },
  },
  {
    name: 'purchase_order_create',
    description:
      'Создать заказ поставщику при дефиците комплектующих (POST /entity/purchaseorder).',
    inputSchema: {
      type: 'object',
      properties: { payload: { type: 'object' } },
      required: ['payload'],
      additionalProperties: false,
    },
  },
  {
    name: 'counterparty_balance',
    description:
      'Проверить дебиторскую задолженность контрагента (GET /report/counterparty).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        offset: { type: 'integer', minimum: 0 },
        filter: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'bundle_get',
    description:
      'Прочитать состав комплекта/спецификации по ID или артикулу (GET /entity/bundle).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        article: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
];

const READ_PATHS = Object.freeze({
  product_list: '/entity/product',
  stock_report: '/report/stock/all',
  customer_order_list: '/entity/customerorder',
  counterparty_list: '/entity/counterparty',
  counterparty_balance: '/report/counterparty',
});

const GET_PATHS = Object.freeze({
  product_get: '/entity/product',
  customer_order_get: '/entity/customerorder',
});

const CREATE_PATHS = Object.freeze({
  customer_order_create: '/entity/customerorder',
  demand_create: '/entity/demand',
  purchase_order_create: '/entity/purchaseorder',
});

function cleanQuery(input) {
  const result = {};

  if (input.limit !== undefined) {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new Error('limit должен быть целым от 1 до 100');
    }
    result.limit = String(input.limit);
  }

  if (input.offset !== undefined) {
    if (!Number.isInteger(input.offset) || input.offset < 0) {
      throw new Error('offset должен быть целым >= 0');
    }
    result.offset = String(input.offset);
  }

  for (const key of ['filter', 'search', 'expand']) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'string') {
        throw new Error(`${key} должен быть строкой`);
      }
      result[key] = input[key];
    }
  }

  return result;
}

function cleanReportQuery(input) {
  const query = cleanQuery(input);
  delete query.search;
  delete query.expand;
  return query;
}

function safeEntityId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) {
    throw new Error('id должен содержать только буквы, цифры, дефис и _');
  }

  return value;
}

export async function callMoySkladTool(name, args, options = {}) {
  const urlBase = options.baseUrl ?? baseUrl;
  const tokenValue = options.token ?? token;

  if (!urlBase) {
    throw new Error('MOYSKLAD_BASE_URL не задан или некорректен');
  }

  if (!tokenValue) {
    throw new Error('MOYSKLAD_TOKEN не задан');
  }

  const input = asObject(args);
  let path;
  let method = 'GET';
  let body;
  let query = {};

  if (READ_PATHS[name] !== undefined) {
    path = READ_PATHS[name];
    query =
      name === 'counterparty_balance' ? cleanReportQuery(input) : cleanQuery(input);
  } else if (GET_PATHS[name] !== undefined) {
    path = `${GET_PATHS[name]}/${encodeURIComponent(safeEntityId(input.id))}`;
  } else if (name === 'bundle_get') {
    if (input.id !== undefined) {
      path = `/entity/bundle/${encodeURIComponent(safeEntityId(input.id))}`;
    } else if (
      typeof input.article === 'string' &&
      input.article.trim() !== ''
    ) {
      path = '/entity/bundle';
      query = {
        filter: `article=${input.article.trim()}`,
        limit: '1',
      };
    } else {
      throw new Error('bundle_get: нужен id или article');
    }
  } else if (CREATE_PATHS[name] !== undefined) {
    if (
      typeof input.payload !== 'object' ||
      input.payload === null ||
      Array.isArray(input.payload)
    ) {
      throw new Error('payload должен быть объектом');
    }
    path = CREATE_PATHS[name];
    method = 'POST';
    body = JSON.stringify(input.payload);
  } else {
    throw new Error(`Неизвестный инструмент: ${name}`);
  }

  const url = new URL(`${urlBase}${path}`);

  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }

  const response = await fetchWithRetry(
    url,
    {
      method,
      headers: {
        Authorization: `Bearer ${tokenValue}`,
        Accept: 'application/json;charset=utf-8',
        'Content-Type': 'application/json',
        'User-Agent': 'SkillWharf-MCP/0.1.0',
      },
      ...(body === undefined ? {} : { body }),
      redirect: 'error',
    },
    options.timeoutMs ?? REQUEST_TIMEOUT_MS,
  );
  const text = await response.text();
  let data = null;

  try {
    data = text === '' ? null : JSON.parse(text);
  } catch {
    data = null;
  }

  if (!response.ok) {
    const description =
      data?.errors?.[0]?.error ?? data?.error ?? text.slice(0, 300);
    throw new Error(
      `МойСклад HTTP ${response.status}: ${safeDetail(description)}`,
    );
  }

  return data;
}

function isAuthorized(request) {
  if (MCP_AUTH_TOKEN === '') {
    return true;
  }

  const header = request.headers.authorization ?? '';
  const expected = `Bearer ${MCP_AUTH_TOKEN}`;
  const actualBuffer = Buffer.from(header);
  const expectedBuffer = Buffer.from(expected);

  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body слишком большой'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw === '' ? {} : JSON.parse(raw));
      } catch {
        reject(new Error('некорректный JSON'));
      }
    });

    request.on('error', reject);
  });
}

function sseWrite(response, data) {
  if (response.destroyed) {
    return;
  }
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

async function handleRpc(message, credentials = {}) {
  const method = message.method;

  if (method === 'initialize') {
    return {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVICE_NAME, version: '0.1.0' },
    };
  }

  if (method === 'ping') {
    return {};
  }

  if (method === 'tools/list') {
    return { tools: TOOLS };
  }

  if (method === 'tools/call') {
    const params = asObject(message.params ?? {});
    const name = params.name;

    if (typeof name !== 'string') {
      throw new Error('tools/call: name обязателен');
    }

    try {
      const result = await callMoySkladTool(name, params.arguments ?? {}, {
        token: credentials.token,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        isError: false,
      };
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: safeDetail(error instanceof Error ? error.message : error),
          },
        ],
        isError: true,
      };
    }
  }

  throw new Error(`Неизвестный метод: ${String(method)}`);
}

const sessions = new Map();

const server = createServer(async (request, response) => {
  const url = new URL(
    request.url ?? '/',
    `http://${request.headers.host ?? 'localhost'}`,
  );

  if (request.method === 'GET' && url.pathname === '/api/health') {
    const configured = baseUrl !== null && token !== '';

    if (!configured && !ALLOW_MISSING_KEYS) {
      sendJson(response, 503, {
        status: 'error',
        service: SERVICE_NAME,
        missing: [
          ...(baseUrl === null ? ['MOYSKLAD_BASE_URL'] : []),
          ...(token === '' ? ['MOYSKLAD_TOKEN'] : []),
        ],
      });
      return;
    }

    sendJson(response, 200, {
      status: 'ok',
      service: SERVICE_NAME,
      configured,
    });
    return;
  }

  if (!isAuthorized(request)) {
    sendJson(response, 401, { status: 'error', message: 'unauthorized' });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/sse') {
    // Токен приходит заголовком на SSE-запрос; он же обслуживает последующие
    // tools/call в этой сессии (`MCP-24.1`).
    const sessionToken = resolveMoyskladTokenFromHeaders(request.headers);
    const sessionId = randomUUID();
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.write(`event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`);

    const heartbeat = setInterval(() => {
      if (!response.destroyed) {
        response.write(': keep-alive\n\n');
      }
    }, 15_000);
    heartbeat.unref();

    sessions.set(sessionId, { response, heartbeat, token: sessionToken });

    const cleanup = () => {
      clearInterval(heartbeat);
      sessions.delete(sessionId);
    };
    request.on('close', cleanup);
    response.on('close', cleanup);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/messages') {
    const sessionId = url.searchParams.get('sessionId') ?? '';
    const session = sessions.get(sessionId);

    if (session === undefined) {
      sendJson(response, 404, { status: 'error', message: 'session not found' });
      return;
    }

    let message;
    try {
      message = await readJson(request);
    } catch (error) {
      sendJson(response, 400, {
        status: 'error',
        message: error instanceof Error ? error.message : 'bad request',
      });
      return;
    }

    if (message.id === undefined) {
      sendJson(response, 202, { status: 'accepted' });
      return;
    }

    // Заголовок на POST переопределяет токен, сохранённый в SSE-сессии.
    const requestToken = resolveMoyskladTokenFromHeaders(
      request.headers,
      session.token,
    );

    try {
      const result = await handleRpc(message, { token: requestToken });
      sseWrite(session.response, {
        jsonrpc: '2.0',
        id: message.id,
        result,
      });
    } catch (error) {
      sseWrite(session.response, {
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32602,
          message: safeDetail(error instanceof Error ? error.message : error),
        },
      });
    }

    sendJson(response, 202, { status: 'accepted' });
    return;
  }

  sendJson(response, 404, { status: 'error', message: 'not found' });
});

server.on('clientError', (_error, socket) => {
  socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`${SERVICE_NAME} listening on :${PORT} (configured=${baseUrl !== null && token !== ''})`);
  });
}

export { server, TOOLS };
