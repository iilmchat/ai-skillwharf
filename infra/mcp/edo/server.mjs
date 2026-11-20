import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

/**
 * MCP-сервер юридически значимого ЭДО (Sprint 41 / EDO-41.1).
 *
 * Поддерживает два провайдера:
 *  - diadoc — Контур.Диадок, REST API `V3/*` с DiadocAuth;
 *  - sbis   — СБИС (Saby), JSON-RPC (`СБИС.*`) с X-SBISSessionID.
 *
 * Креды приходят per-request заголовками (MCP-24.1) с fallback на env.
 * Криптоподпись КЭП на сервере НЕ выполняется — только формирование пакета
 * документов к подписанию. Секреты не попадают в логи и ошибки.
 */

/** @typedef {'diadoc' | 'sbis'} EdoProvider */
/**
 * @typedef {{
 *   provider: EdoProvider,
 *   apiKey: string,
 *   token: string,
 *   boxId: string,
 *   diadocUrl: string,
 *   sbisUrl: string
 * }} EdoCredentials
 */

const PORT = Number.parseInt(process.env.PORT ?? '5006', 10);
const SERVICE_NAME = 'edo-mcp';
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN?.trim() ?? '';
const ALLOW_MISSING_KEYS = process.env.MCP_ALLOW_MISSING_KEYS === '1';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 1_048_576;
const PROTOCOL_VERSION = '2024-11-05';
const MAX_TOOL_ATTEMPTS = 2;
const RETRY_BASE_DELAY_MS = 200;
const DEFAULT_DIADOC_URL = 'https://kontur.ru';
const DEFAULT_SBIS_URL = 'https://sbis.ru';

const PROVIDER_HEADER = 'x-edo-provider';
const API_KEY_HEADER = 'x-edo-api-key';
const TOKEN_HEADER = 'x-edo-token';
const BOX_ID_HEADER = 'x-edo-box-id';

/** @returns {EdoCredentials} */
function envCredentials() {
  const provider = (process.env.EDO_PROVIDER?.trim() || 'diadoc').toLowerCase();
  return {
    provider: provider === 'sbis' ? 'sbis' : 'diadoc',
    apiKey: process.env.EDO_API_KEY?.trim() ?? '',
    token: process.env.EDO_TOKEN?.trim() ?? '',
    boxId: process.env.EDO_BOX_ID?.trim() ?? '',
    diadocUrl: (process.env.DIADOC_API_URL?.trim() || DEFAULT_DIADOC_URL).replace(/\/+$/, ''),
    sbisUrl: (process.env.SBIS_API_URL?.trim() || DEFAULT_SBIS_URL).replace(/\/+$/, ''),
  };
}

/**
 * @param {unknown} raw
 * @returns {EdoProvider}
 */
export function normalizeProvider(raw) {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (value === 'diadoc' || value === 'sbis') {
    return value;
  }
  throw new Error('provider должен быть diadoc или sbis');
}

/** @param {string} raw */
function normalizeBaseUrl(raw, service) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`${service}: разрешены только http и https`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error(`${service}: URL не должен содержать логин/пароль`);
  }
  return url.toString().replace(/\/+$/, '');
}

function isAuthorized(request) {
  if (MCP_AUTH_TOKEN === '') {
    return true;
  }
  const expected = Buffer.from(`Bearer ${MCP_AUTH_TOKEN}`);
  const actual = Buffer.from(request.headers.authorization ?? '');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Вычищает секреты из любого текста, который может попасть в ошибку. @param {unknown} value */
export function safeDetail(value) {
  return String(value)
    .replace(/ddauth_api_client_id=[^,\s]+/gi, 'ddauth_api_client_id=[REDACTED]')
    .replace(/ddauth_token=[^,\s]+/gi, 'ddauth_token=[REDACTED]')
    .replace(/X-SBISSessionID\s*[:=]\s*\S+/gi, 'X-SBISSessionID: [REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/(Basic\s+)\S+/gi, '$1[REDACTED]')
    .replace(/"(token|apiKey|sessionId|secret)"\s*:\s*"[^"]*"/gi, '"$1": "[REDACTED]"')
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
 * @param {EdoCredentials} [fallback]
 * @returns {EdoCredentials}
 */
export function resolveEdoCredentialsFromHeaders(headers, fallback = envCredentials()) {
  const providerRaw = headerValue(headers, PROVIDER_HEADER).trim();
  return {
    provider: providerRaw === '' ? fallback.provider : normalizeProvider(providerRaw),
    apiKey: headerValue(headers, API_KEY_HEADER).trim() || fallback.apiKey,
    token: headerValue(headers, TOKEN_HEADER).trim() || fallback.token,
    boxId: headerValue(headers, BOX_ID_HEADER).trim() || fallback.boxId,
    diadocUrl: fallback.diadocUrl,
    sbisUrl: fallback.sbisUrl,
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
    name: 'edo_list_incoming_documents',
    description:
      'Список входящих незавершённых УПД, актов и счетов-фактур (Диадок: V3/GetDocuments, СБИС: СБИС.СписокДокументов).',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } },
      additionalProperties: false,
    },
  },
  {
    name: 'edo_get_document_details',
    description:
      'Реквизиты документа и товарные позиции: наименование, количество, цена, НДС, сумма.',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: { type: 'string' },
        messageId: { type: 'string' },
      },
      required: ['documentId'],
      additionalProperties: false,
    },
  },
  {
    name: 'edo_prepare_sign_packet',
    description:
      'Подготовить черновик ответного титула покупателя / согласования к подписи КЭП (без самой подписи).',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: { type: 'string' },
        signer: { type: 'string' },
        comment: { type: 'string' },
      },
      required: ['documentId'],
      additionalProperties: false,
    },
  },
  {
    name: 'edo_reject_document',
    description:
      'Сформировать уведомление об уточнении/отклонении документа с причиной расхождения.',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: { type: 'string' },
        reason: { type: 'string' },
      },
      required: ['documentId', 'reason'],
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
function cleanLimit(value) {
  if (value === undefined) return 50;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error('limit должен быть целым от 1 до 100');
  }
  return value;
}

/**
 * Вызывает инструмент ЭДО. Секреты передаются через options, не логируются.
 * @param {string} name
 * @param {unknown} args
 * @param {Partial<EdoCredentials> & { timeoutMs?: number }} [options]
 */
export async function callEdoTool(name, args, options = {}) {
  const credentials = {
    provider: options.provider ?? envCredentials().provider,
    apiKey: options.apiKey ?? envCredentials().apiKey,
    token: options.token ?? envCredentials().token,
    boxId: options.boxId ?? envCredentials().boxId,
    diadocUrl: options.diadocUrl ?? envCredentials().diadocUrl,
    sbisUrl: options.sbisUrl ?? envCredentials().sbisUrl,
  };
  const provider = normalizeProvider(credentials.provider);

  if (credentials.boxId === '') {
    throw new Error('EDO_BOX_ID / X-Edo-Box-Id не задан');
  }
  if (credentials.token === '') {
    throw new Error('EDO_TOKEN / X-Edo-Token не задан');
  }
  if (provider === 'diadoc' && credentials.apiKey === '') {
    throw new Error('EDO_API_KEY / X-Edo-Api-Key не задан (нужен для DiadocAuth)');
  }

  const input = asObject(args);
  const timeout = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

  /** @type {string} */
  let url;
  /** @type {Record<string, string>} */
  let headers = { 'user-agent': 'SkillWharf-MCP/0.1.0' };
  let method = 'GET';
  /** @type {string | undefined} */
  let body;

  if (provider === 'diadoc') {
    const base = normalizeBaseUrl(credentials.diadocUrl, 'Диадок');
    headers = {
      ...headers,
      Authorization: `DiadocAuth ddauth_api_client_id=${credentials.apiKey},ddauth_token=${credentials.token}`,
      Accept: 'application/json',
    };

    if (name === 'edo_list_incoming_documents') {
      const query = new URLSearchParams({
        boxId: credentials.boxId,
        filterCategory: 'Any.InboundNotFinished',
      });
      url = `${base}/V3/GetDocuments?${query.toString()}`;
    } else if (name === 'edo_get_document_details') {
      const query = new URLSearchParams({ boxId: credentials.boxId });
      const messageId = input.messageId;
      if (typeof messageId === 'string' && messageId.trim() !== '') {
        query.set('messageId', messageId.trim());
      }
      query.set('documentId', requiredString(input.documentId, 'documentId'));
      url = `${base}/V3/GetDocument?${query.toString()}`;
    } else if (name === 'edo_reject_document') {
      method = 'POST';
      headers = { ...headers, 'content-type': 'application/json' };
      url = `${base}/V3/SendAmendmentRequest`;
      body = JSON.stringify({
        boxId: credentials.boxId,
        documentId: requiredString(input.documentId, 'documentId'),
        reason: requiredString(input.reason, 'reason'),
      });
    } else if (name === 'edo_prepare_sign_packet') {
      // Пакет формируется локально: криптоподпись выполняет КЭП руководителя.
      return {
        provider: 'diadoc',
        boxId: credentials.boxId,
        documentId: requiredString(input.documentId, 'documentId'),
        titleType: 'BuyerTitle',
        signer: typeof input.signer === 'string' ? input.signer : null,
        comment: typeof input.comment === 'string' ? input.comment : null,
        unsigned: true,
      };
    } else {
      throw new Error(`Неизвестный инструмент: ${name}`);
    }
  } else {
    const base = normalizeBaseUrl(credentials.sbisUrl, 'СБИС');
    method = 'POST';
    headers = {
      ...headers,
      'content-type': 'application/json',
      'X-SBISSessionID': credentials.token,
    };

    /** @type {Record<string, string | number>} */
    let params = { boxId: credentials.boxId };
    /** @type {string} */
    let rpcMethod;

    if (name === 'edo_list_incoming_documents') {
      rpcMethod = 'СБИС.СписокДокументов';
      params = { ...params, category: 'InboundNotFinished', limit: cleanLimit(input.limit) };
    } else if (name === 'edo_get_document_details') {
      rpcMethod = 'СБИС.ПрочитатьДокумент';
      params = { ...params, documentId: requiredString(input.documentId, 'documentId') };
    } else if (name === 'edo_prepare_sign_packet') {
      rpcMethod = 'СБИС.ПодготовитьПодпись';
      params = {
        ...params,
        documentId: requiredString(input.documentId, 'documentId'),
        decision: 'approve',
      };
    } else if (name === 'edo_reject_document') {
      rpcMethod = 'СБИС.ОтклонитьДокумент';
      params = {
        ...params,
        documentId: requiredString(input.documentId, 'documentId'),
        reason: requiredString(input.reason, 'reason'),
      };
    } else {
      throw new Error(`Неизвестный инструмент: ${name}`);
    }

    url = `${base}/jsonrpc`;
    body = JSON.stringify({
      jsonrpc: '2.0',
      id: randomUUID(),
      method: rpcMethod,
      params,
    });
  }

  const response = await fetchWithRetry(
    url,
    {
      method,
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
    throw new Error(`ЭДО HTTP ${response.status}: ${safeDetail(text.slice(0, 300))}`);
  }
  if (data && typeof data === 'object' && 'error' in data) {
    throw new Error(`ЭДО RPC: ${safeDetail(JSON.stringify(data.error))}`);
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

/** @param {Record<string, unknown>} message @param {EdoCredentials} credentials */
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
      const result = await callEdoTool(name, params.arguments ?? {}, credentials);
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

/** @type {Map<string, { response: import('node:http').ServerResponse, heartbeat: NodeJS.Timeout, credentials: EdoCredentials }>} */
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
    const configured =
      env.boxId !== '' && env.token !== '' &&
      (env.provider === 'sbis' || env.apiKey !== '');

    if (!configured && !ALLOW_MISSING_KEYS) {
      sendJson(response, 503, {
        status: 'error',
        service: SERVICE_NAME,
        missing: [
          ...(env.boxId === '' ? ['EDO_BOX_ID'] : []),
          ...(env.token === '' ? ['EDO_TOKEN'] : []),
          ...(env.provider === 'diadoc' && env.apiKey === '' ? ['EDO_API_KEY'] : []),
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
      credentials: resolveEdoCredentialsFromHeaders(request.headers),
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

    const credentials = resolveEdoCredentialsFromHeaders(
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
