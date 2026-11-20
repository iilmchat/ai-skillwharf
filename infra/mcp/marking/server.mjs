import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

/**
 * MCP-сервер проверки маркировки DataMatrix (Sprint 42 / MARK-42.1).
 *
 * Провайдер — ГИС МТ «Честный ЗНАК» (True API). Креды приходят per-request
 * заголовками (MCP-24.1) с fallback на env. Криптоподпись и отправка уведомлений
 * в ГИС МТ на сервере НЕ выполняются — только черновики (`draftOnly`).
 * Секреты и коды маркировки не попадают в логи и ошибки.
 */

/** @typedef {{ token: string, inn: string, apiUrl: string }} MarkingCredentials */

const PORT = Number.parseInt(process.env.PORT ?? '5007', 10);
const SERVICE_NAME = 'marking-mcp';
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN?.trim() ?? '';
const ALLOW_MISSING_KEYS = process.env.MCP_ALLOW_MISSING_KEYS === '1';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 1_048_576;
const PROTOCOL_VERSION = '2024-11-05';
const MAX_TOOL_ATTEMPTS = 2;
const RETRY_BASE_DELAY_MS = 200;
const DEFAULT_API_URL = 'https://crpt.ru';

const TOKEN_HEADER = 'x-marking-token';
const INN_HEADER = 'x-marking-inn';

/** @returns {MarkingCredentials} */
function envCredentials() {
  return {
    token: process.env.MARKING_TOKEN?.trim() ?? '',
    inn: process.env.MARKING_INN?.trim() ?? '',
    apiUrl: (process.env.MARKING_API_URL?.trim() || DEFAULT_API_URL).replace(/\/+$/, ''),
  };
}

/**
 * ИНН организации — 10 или 12 цифр.
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeInn(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d{10}$|^\d{12}$/.test(value)) {
    throw new Error('ИНН должен содержать 10 или 12 цифр');
  }
  return value;
}

/** @param {string} raw */
function normalizeBaseUrl(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('MARKING_API_URL: разрешены только http и https');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('MARKING_API_URL не должен содержать логин/пароль');
  }
  return url.toString().replace(/\/+$/, '');
}

function isAuthorized(request) {
  if (MCP_AUTH_TOKEN === '') return true;
  const expected = Buffer.from(`Bearer ${MCP_AUTH_TOKEN}`);
  const actual = Buffer.from(request.headers.authorization ?? '');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Маскирует Bearer-токены и коды DataMatrix в любом тексте ошибки.
 * @param {unknown} value
 */
export function safeDetail(value) {
  return String(value)
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/(X-Marking-Token|MARKING_TOKEN)\s*[:=]\s*\S+/gi, '$1: [REDACTED]')
    .replace(/"cis"\s*:\s*"[^"]*"/gi, '"cis": "[REDACTED]"')
    // GS1 DataMatrix: (01)+14 цифр GTIN, (21)+серийный номер, склеенные коды.
    .replace(/01\d{14}/g, '01[REDACTED]')
    .replace(/21[A-Za-z0-9_-]{4,}/g, '21[REDACTED]')
    .replace(/\b\d{14}\b/g, '[GTIN_REDACTED]')
    .replace(/\b\d{20,}\b/g, '[REDACTED]')
    .slice(0, 400);
}

/** @param {import('node:http').IncomingHttpHeaders} headers @param {string} name */
function headerValue(headers, name) {
  const value = headers[name];
  if (Array.isArray(value)) return value[0] ?? '';
  return typeof value === 'string' ? value : '';
}

/**
 * Креды из per-request заголовков с fallback на env.
 * @param {import('node:http').IncomingHttpHeaders} headers
 * @param {MarkingCredentials} [fallback]
 * @returns {MarkingCredentials}
 */
export function resolveMarkingCredentialsFromHeaders(headers, fallback = envCredentials()) {
  const token = headerValue(headers, TOKEN_HEADER).trim() || fallback.token;
  const innRaw = headerValue(headers, INN_HEADER).trim() || fallback.inn;
  return {
    token,
    inn: innRaw === '' ? '' : normalizeInn(innRaw),
    apiUrl: fallback.apiUrl,
  };
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** @param {string} url @param {RequestInit} init @param {number} timeoutMs */
async function fetchWithRetry(url, init, timeoutMs) {
  for (let attempt = 1; ; attempt += 1) {
    let response;
    try {
      response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (attempt >= MAX_TOOL_ATTEMPTS) throw error;
      await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      continue;
    }
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= MAX_TOOL_ATTEMPTS) return response;
    await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
  }
}

const TOOLS = [
  {
    name: 'marking_check_codes',
    description:
      'Пакетная проверка кодов DataMatrix через True API (POST /cises/info): статус, владелец, товар, GTIN и срок годности.',
    inputSchema: {
      type: 'object',
      properties: {
        codes: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 100,
        },
      },
      required: ['codes'],
      additionalProperties: false,
    },
  },
  {
    name: 'marking_document_status',
    description: 'Статус электронного документа в ГИС МТ (GET /doc/{docId}/info).',
    inputSchema: {
      type: 'object',
      properties: { docId: { type: 'string' } },
      required: ['docId'],
      additionalProperties: false,
    },
  },
  {
    name: 'marking_create_discrepancy_draft',
    description:
      'Черновик уведомления/акта о расхождении кодов при приёмке (draftOnly, без криптоподписи и отправки).',
    inputSchema: {
      type: 'object',
      properties: {
        docId: { type: 'string' },
        discrepancies: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              cis: { type: 'string' },
              reason: { type: 'string' },
            },
            required: ['cis', 'reason'],
            additionalProperties: false,
          },
        },
      },
      required: ['docId', 'discrepancies'],
      additionalProperties: false,
    },
  },
];

/** @param {unknown} value */
function asObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('arguments должен быть объектом');
  }
  return value;
}

/** @param {unknown} value */
function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} обязателен и должен быть строкой`);
  }
  return value.trim();
}

/** @param {unknown} value */
function cleanCodes(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new Error('codes должен быть массивом от 1 до 100 кодов');
  }
  return value.map((code, index) => {
    if (typeof code !== 'string' || code.trim() === '') {
      throw new Error(`codes[${index}] должен быть непустой строкой`);
    }
    return code.trim();
  });
}

/**
 * Вызывает инструмент маркировки. Секреты и коды не логируются.
 * @param {string} name
 * @param {unknown} args
 * @param {Partial<MarkingCredentials> & { timeoutMs?: number }} [options]
 */
export async function callMarkingTool(name, args, options = {}) {
  const env = envCredentials();
  const credentials = {
    token: options.token ?? env.token,
    inn: options.inn ?? env.inn,
    apiUrl: options.apiUrl ?? env.apiUrl,
  };

  if (credentials.token === '') {
    throw new Error('MARKING_TOKEN / X-Marking-Token не задан');
  }
  if (credentials.inn === '') {
    throw new Error('MARKING_INN / X-Marking-Inn не задан');
  }
  const base = normalizeBaseUrl(credentials.apiUrl);
  const input = asObject(args);
  const timeout = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  const headers = {
    Authorization: `Bearer ${credentials.token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'user-agent': 'SkillWharf-MCP/0.1.0',
  };

  if (name === 'marking_create_discrepancy_draft') {
    const discrepancies = input.discrepancies;
    if (!Array.isArray(discrepancies) || discrepancies.length === 0) {
      throw new Error('discrepancies должен быть непустым массивом');
    }
    const items = discrepancies.map((entry, index) => {
      const object = asObject(entry);
      return {
        cis: requiredString(object.cis, `discrepancies[${index}].cis`),
        reason: requiredString(object.reason, `discrepancies[${index}].reason`),
      };
    });
    return {
      draftOnly: true,
      submitted: false,
      signed: false,
      docId: requiredString(input.docId, 'docId'),
      inn: credentials.inn,
      discrepancies: items,
    };
  }

  /** @type {string} */
  let url;
  /** @type {string | undefined} */
  let body;

  if (name === 'marking_check_codes') {
    url = `${base}/cises/info`;
    body = JSON.stringify({ cises: cleanCodes(input.codes), inn: credentials.inn });
  } else if (name === 'marking_document_status') {
    url = `${base}/doc/${encodeURIComponent(requiredString(input.docId, 'docId'))}/info`;
  } else {
    throw new Error(`Неизвестный инструмент: ${name}`);
  }

  const response = await fetchWithRetry(
    url,
    {
      method: name === 'marking_check_codes' ? 'POST' : 'GET',
      headers,
      ...(body === undefined ? {} : { body }),
      redirect: 'error',
    },
    timeout,
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
    throw new Error(`Честный ЗНАК HTTP ${response.status}: ${safeDetail(text.slice(0, 300))}`);
  }

  if (name === 'marking_check_codes') {
    const root = data && typeof data === 'object' ? data : {};
    const rows = 'results' in root && Array.isArray(root.results) ? root.results : data;
    const list = Array.isArray(rows) ? rows : [];
    return {
      results: list.map((row) => {
        const item = asObject(row);
        return {
          cis: typeof item.cis === 'string' ? item.cis : '',
          status: typeof item.status === 'string' ? item.status : 'UNKNOWN',
          ownerInn: typeof item.ownerInn === 'string' ? item.ownerInn : '',
          productName: typeof item.productName === 'string' ? item.productName : '',
          gtin: typeof item.gtin === 'string' ? item.gtin : '',
          expirationDate:
            typeof item.expirationDate === 'string' ? item.expirationDate : null,
        };
      }),
    };
  }

  return data;
}

function sendJson(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
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
        resolve(asObject(raw === '' ? {} : JSON.parse(raw)));
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

/** @param {Record<string, unknown>} message @param {MarkingCredentials} credentials */
async function handleRpc(message, credentials) {
  const method = message.method;

  if (method === 'initialize') {
    return {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVICE_NAME, version: '0.1.0' },
    };
  }
  if (method === 'ping') return {};
  if (method === 'tools/list') return { tools: TOOLS };

  if (method === 'tools/call') {
    const params = asObject(message.params ?? {});
    const name = params.name;
    if (typeof name !== 'string') {
      throw new Error('tools/call: name обязателен');
    }
    try {
      const result = await callMarkingTool(name, params.arguments ?? {}, credentials);
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

/** @type {Map<string, { response: import('node:http').ServerResponse, heartbeat: NodeJS.Timeout, credentials: MarkingCredentials }>} */
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
    const env = envCredentials();
    const configured = env.token !== '' && env.inn !== '';
    if (!configured && !ALLOW_MISSING_KEYS) {
      sendJson(response, 503, {
        status: 'error',
        service: SERVICE_NAME,
        missing: [
          ...(env.token === '' ? ['MARKING_TOKEN'] : []),
          ...(env.inn === '' ? ['MARKING_INN'] : []),
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
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    response.write(`event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`);

    const heartbeat = setInterval(() => {
      if (!response.destroyed) response.write(': keep-alive\n\n');
    }, 15_000);
    heartbeat.unref();

    sessions.set(sessionId, {
      response,
      heartbeat,
      credentials: resolveMarkingCredentialsFromHeaders(request.headers),
    });

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

    const credentials = resolveMarkingCredentialsFromHeaders(
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
    console.log(`${SERVICE_NAME} listening on :${PORT}`);
  });
}

export { server, TOOLS };
