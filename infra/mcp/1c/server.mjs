import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

/**
 * MCP-сервер для 1С:Предприятие 8.3 (УТ / Бухгалтерия / ERP) через OData.
 *
 * Транспорт совместим с apps/api/src/agent/tools/mcp-client.ts:
 * GET /sse + POST /messages, пинг и диагностика — GET /health и /api/health.
 * Креды 1С приходят per-request заголовками (MCP-24.1) с fallback на env.
 * Секреты никогда не попадают в логи и сообщения об ошибках.
 */

/** @typedef {{ odataUrl: string, username: string, password: string }} OneCCredentials */

const PORT = Number.parseInt(process.env.PORT ?? '5005', 10);
const SERVICE_NAME = '1c-mcp';
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN?.trim() ?? '';
const ALLOW_MISSING_KEYS = process.env.MCP_ALLOW_MISSING_KEYS === '1';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 1_048_576;
const PROTOCOL_VERSION = '2024-11-05';
const MAX_TOOL_ATTEMPTS = 2;
const RETRY_BASE_DELAY_MS = 200;
const ODATA_SUFFIX = '/odata/standard.odata';

const ODATA_URL_HEADER = 'x-1c-odata-url';
const USERNAME_HEADER = 'x-1c-username';
const PASSWORD_HEADER = 'x-1c-password';

const envODataUrl = process.env.ONEC_ODATA_URL?.trim() ?? '';
const envUsername = process.env.ONEC_USERNAME?.trim() ?? '';
const envPassword = process.env.ONEC_PASSWORD ?? '';

/** @returns {OneCCredentials} */
function envCredentials() {
  return { odataUrl: envODataUrl, username: envUsername, password: envPassword };
}

function isAuthorized(request) {
  if (MCP_AUTH_TOKEN === '') {
    return true;
  }

  const expected = `Bearer ${MCP_AUTH_TOKEN}`;
  const actualBuffer = Buffer.from(request.headers.authorization ?? '');
  const expectedBuffer = Buffer.from(expected);

  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function safeDetail(value) {
  return String(value)
    .replace(/Basic\s+\S+/gi, 'Basic [REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(
      /((?:password|secret|api[-_]?key|token)\s*[:=]\s*)\S+/gi,
      '$1[REDACTED]',
    )
    .slice(0, 300);
}

/** @param {import('node:http').IncomingHttpHeaders} headers */
function headerValue(headers, name) {
  const value = headers[name];
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return typeof value === 'string' ? value : '';
}

/**
 * Проверяет, что URL указывает на публикацию OData 1С.
 * Не принимает userinfo (логин:пароль внутри URL), query и fragment.
 * @param {string} raw
 */
export function normalizeODataUrl(raw) {
  const value = raw.trim();
  if (value === '') {
    throw new Error('X-1C-OData-Url / ONEC_ODATA_URL не задан');
  }

  const url = new URL(value);

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('разрешены только http и https');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('URL не должен содержать логин/пароль — используйте X-1C-Username/Password');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error('URL OData не должен содержать query или fragment');
  }

  const path = url.pathname.replace(/\/+$/, '').toLowerCase();
  if (!path.endsWith(ODATA_SUFFIX)) {
    throw new Error(`URL должен оканчиваться на ${ODATA_SUFFIX}`);
  }

  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/+$/, '');
}

/**
 * Креды из per-request заголовков с fallback на env.
 * @param {import('node:http').IncomingHttpHeaders} headers
 * @param {OneCCredentials} [fallback]
 * @returns {OneCCredentials}
 */
export function resolve1CCredentialsFromHeaders(headers, fallback = envCredentials()) {
  return {
    odataUrl: headerValue(headers, ODATA_URL_HEADER).trim() || fallback.odataUrl,
    username: headerValue(headers, USERNAME_HEADER).trim() || fallback.username,
    password: headerValue(headers, PASSWORD_HEADER) || fallback.password,
  };
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * До двух попыток на 429/5xx и сетевые сбои.
 * @param {string} url
 * @param {RequestInit} init
 * @param {number} timeoutMs
 */
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
    name: '1c_nomenclature_list',
    description:
      'Поиск номенклатуры 1С (GET /Catalog_Номенклатура): по наименованию или артикулу.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        search: { type: 'string', description: 'Наименование или артикул' },
        filter: { type: 'string', description: 'Дополнительный OData-$filter' },
      },
      additionalProperties: false,
    },
  },
  {
    name: '1c_stock_balance',
    description:
      'Остатки товаров на складах (GET /AccumulationRegister_ТоварыНаСкладах/Balance).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        filter: { type: 'string', description: 'OData-$filter, например Склад/Description' },
      },
      additionalProperties: false,
    },
  },
  {
    name: '1c_counterparty_debt',
    description:
      'Задолженность контрагента по ИНН или наименованию (GET /AccumulationRegister_ВзаиморасчетыСКонтрагентами/Balance).',
    inputSchema: {
      type: 'object',
      properties: {
        inn: { type: 'string' },
        name: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
  },
  {
    name: '1c_customer_order_create',
    description:
      'Создание черновика заказа покупателя (POST /Document_ЗаказПокупателя).',
    inputSchema: {
      type: 'object',
      properties: { payload: { type: 'object' } },
      required: ['payload'],
      additionalProperties: false,
    },
  },
];

const ODATA_PATHS = Object.freeze({
  '1c_nomenclature_list': '/Catalog_Номенклатура',
  '1c_stock_balance': '/AccumulationRegister_ТоварыНаСкладах/Balance',
  '1c_counterparty_debt': '/AccumulationRegister_ВзаиморасчетыСКонтрагентами/Balance',
  '1c_customer_order_create': '/Document_ЗаказПокупателя',
});

/** @param {unknown} value */
function asObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('arguments должен быть объектом');
  }
  /** @type {Record<string, unknown>} */
  return value;
}

/** @param {unknown} value */
function cleanLimit(value) {
  if (value === undefined) {
    return 50;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error('limit должен быть целым от 1 до 100');
  }
  return value;
}

/** @param {unknown} value */
function cleanString(value, field) {
  if (value === undefined) {
    return '';
  }
  if (typeof value !== 'string') {
    throw new Error(`${field} должен быть строкой`);
  }
  return value.trim();
}

/** Экранирование одинарных кавычек для OData-строк. @param {string} value */
function odataLiteral(value) {
  return value.replace(/'/g, "''");
}

/**
 * Вызывает инструмент 1С OData. Креды передаются явно через options
 * (per-request), секреты не логируются.
 * @param {string} name
 * @param {unknown} args
 * @param {Partial<OneCCredentials> & { timeoutMs?: number }} [options]
 */
export async function call1CTool(name, args, options = {}) {
  const credentials = {
    odataUrl: options.odataUrl ?? envODataUrl,
    username: options.username ?? envUsername,
    password: options.password ?? envPassword,
  };

  if (credentials.odataUrl === '') {
    throw new Error('ONEC_ODATA_URL / X-1C-OData-Url не задан');
  }
  if (credentials.username === '' || credentials.password === '') {
    throw new Error('ONEC_USERNAME / ONEC_PASSWORD (или X-1C-* заголовки) не заданы');
  }

  const baseUrl = normalizeODataUrl(credentials.odataUrl);
  const input = asObject(args);
  const path = ODATA_PATHS[/** @type {keyof typeof ODATA_PATHS} */ (name)];
  if (path === undefined) {
    throw new Error(`Неизвестный инструмент: ${name}`);
  }

  const params = new URLSearchParams({ '$format': 'json' });
  let method = 'GET';
  /** @type {string | undefined} */
  let body;

  if (name === '1c_nomenclature_list') {
    params.set('$top', String(cleanLimit(input.limit)));
    const search = cleanString(input.search, 'search');
    const extraFilter = cleanString(input.filter, 'filter');
    const parts = [];
    if (search !== '') {
      parts.push(
        `(substringof('${odataLiteral(search)}',Description) or substringof('${odataLiteral(search)}',Артикул))`,
      );
    }
    if (extraFilter !== '') {
      parts.push(`(${extraFilter})`);
    }
    if (parts.length > 0) {
      params.set('$filter', parts.join(' and '));
    }
  } else if (name === '1c_stock_balance') {
    params.set('$top', String(cleanLimit(input.limit)));
    const filter = cleanString(input.filter, 'filter');
    if (filter !== '') {
      params.set('$filter', filter);
    }
  } else if (name === '1c_counterparty_debt') {
    params.set('$top', String(cleanLimit(input.limit)));
    const inn = cleanString(input.inn, 'inn');
    const counterpartyName = cleanString(input.name, 'name');
    const parts = [];
    if (inn !== '') {
      parts.push(`Контрагент/ИНН eq '${odataLiteral(inn)}'`);
    }
    if (counterpartyName !== '') {
      parts.push(`substringof('${odataLiteral(counterpartyName)}',Контрагент/Description)`);
    }
    if (parts.length > 0) {
      params.set('$filter', parts.join(' and '));
    }
  } else {
    const payload = input.payload;
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      throw new Error('payload должен быть объектом');
    }
    method = 'POST';
    body = JSON.stringify(payload);
  }

  const url = new URL(`${baseUrl}${path}?${params.toString()}`);
  const basic = Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64');

  const response = await fetchWithRetry(
    url,
    {
      method,
      headers: {
        Authorization: `Basic ${basic}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'SkillWharf-MCP/0.1.0',
      },
      ...(body === undefined ? {} : { body }),
      redirect: 'error',
    },
    options.timeoutMs ?? REQUEST_TIMEOUT_MS,
  );

  const text = await response.text();
  /** @type {unknown} */
  let data = null;
  try {
    data = text === '' ? null : JSON.parse(text);
  } catch {
    data = null;
  }

  if (!response.ok) {
    throw new Error(`1С OData HTTP ${response.status}: ${safeDetail(text.slice(0, 300))}`);
  }

  return data;
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

/** @returns {Promise<Record<string, unknown>>} */
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
        const parsed = raw === '' ? {} : JSON.parse(raw);
        resolve(asObject(parsed));
      } catch (error) {
        reject(error instanceof Error ? error : new Error('некорректный JSON'));
      }
    });

    request.on('error', reject);
  });
}

function sseWrite(response, data) {
  if (!response.destroyed) {
    response.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}

/**
 * @param {Record<string, unknown>} message
 * @param {OneCCredentials} credentials
 */
async function handleRpc(message, credentials) {
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
      const result = await call1CTool(name, params.arguments ?? {}, credentials);
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

/** @type {Map<string, { response: import('node:http').ServerResponse, heartbeat: NodeJS.Timeout, credentials: OneCCredentials }>} */
const sessions = new Map();

const server = createServer(async (request, response) => {
  const url = new URL(
    request.url ?? '/',
    `http://${request.headers.host ?? 'localhost'}`,
  );

  if (
    request.method === 'GET' &&
    (url.pathname === '/health' || url.pathname === '/api/health')
  ) {
    const configured = envODataUrl !== '' && envUsername !== '' && envPassword !== '';

    if (!configured && !ALLOW_MISSING_KEYS) {
      sendJson(response, 503, {
        status: 'error',
        service: SERVICE_NAME,
        missing: [
          ...(envODataUrl === '' ? ['ONEC_ODATA_URL'] : []),
          ...(envUsername === '' ? ['ONEC_USERNAME'] : []),
          ...(envPassword === '' ? ['ONEC_PASSWORD'] : []),
        ],
      });
      return;
    }

    sendJson(response, 200, { status: 'ok', service: SERVICE_NAME, configured });
    return;
  }

  if (!isAuthorized(request)) {
    sendJson(response, 401, { status: 'error', message: 'unauthorized' });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/sse') {
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

    /** @type {OneCCredentials} */
    const credentials = {
      odataUrl: headerValue(request.headers, ODATA_URL_HEADER).trim() || envODataUrl,
      username: headerValue(request.headers, USERNAME_HEADER).trim() || envUsername,
      password: headerValue(request.headers, PASSWORD_HEADER) || envPassword,
    };
    sessions.set(sessionId, { response, heartbeat, credentials });

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

    /** @type {Record<string, unknown>} */
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

    const credentials = resolve1CCredentialsFromHeaders(
      request.headers,
      session.credentials,
    );

    try {
      const result = await handleRpc(message, credentials);
      sseWrite(session.response, { jsonrpc: '2.0', id: message.id, result });
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
    console.log(
      `${SERVICE_NAME} listening on :${PORT} (configured=${envODataUrl !== '' && envUsername !== '' && envPassword !== ''})`,
    );
  });
}

export { server, TOOLS };
