import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

/**
 * Минимальный MCP-сервер для Битрикс24.
 *
 * Транспорт: MCP HTTP/SSE (GET /sse + POST /messages), совместимый с
 * apps/api/src/agent/tools/mcp-client.ts. Инструменты вызывают реальные
 * методы REST API через Inbound Webhook.
 */

const PORT = Number.parseInt(process.env.PORT ?? '5003', 10);
const SERVICE_NAME = 'bitrix24-mcp';
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN?.trim() ?? '';
const ALLOW_MISSING_KEYS = process.env.MCP_ALLOW_MISSING_KEYS === '1';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 1_048_576;
const PROTOCOL_VERSION = '2024-11-05';
const BITRIX24_WEBHOOK_HEADER = 'x-bitrix24-webhook-url';

const webhookRaw = process.env.BITRIX24_WEBHOOK_URL?.trim() ?? '';
let webhookUrl = null;

try {
  webhookUrl = webhookRaw === '' ? null : normalizeWebhookUrl(webhookRaw);
} catch (error) {
  console.error(
    `${SERVICE_NAME}: BITRIX24_WEBHOOK_URL некорректен: ${safeDetail(
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

function normalizeWebhookUrl(raw) {
  const url = new URL(raw);

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('разрешены только http/https');
  }

  const local = isLocalHost(url.hostname);

  if (!local) {
    if (url.protocol !== 'https:') {
      throw new Error('внешний webhook должен использовать https');
    }

    if (
      url.hostname !== 'bitrix24.ru' &&
      !url.hostname.endsWith('.bitrix24.ru')
    ) {
      throw new Error('webhook должен указывать на *.bitrix24.ru');
    }
  }

  if (!url.pathname.includes('/rest/')) {
    throw new Error('webhook должен содержать путь /rest/<user_id>/<token>/');
  }

  if (!url.pathname.endsWith('/')) {
    url.pathname = `${url.pathname}/`;
  }

  url.search = '';
  url.hash = '';

  return url.toString();
}

function headerValue(headers, name) {
  const value = headers[name];

  if (Array.isArray(value)) {
    return value[0] ?? '';
  }

  return typeof value === 'string' ? value : '';
}

/**
 * Креды приходят либо в заголовке MCP-сессии, либо из env контейнера.
 * Значение заголовка никогда не попадает в логи: ошибки без содержимого URL.
 */
export function resolveBitrixWebhookFromHeaders(headers, fallback = webhookUrl) {
  const raw = headerValue(headers, BITRIX24_WEBHOOK_HEADER).trim();

  if (raw === '') {
    return fallback ?? null;
  }

  try {
    return normalizeWebhookUrl(raw);
  } catch {
    throw new Error(
      'некорректный X-Bitrix24-Webhook-Url: ожидается https://<portal>.bitrix24.ru/rest/<user_id>/<token>/',
    );
  }
}

function safeDetail(value) {
  return String(value)
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(
      /((?:token|webhook|authorization|api[-_]?key|secret)\s*[:=]\s*)\S+/gi,
      '$1[REDACTED]',
    )
    .slice(0, 300);
}

const TOOL_METHODS = Object.freeze({
  crm_deal_list: 'crm.deal.list',
  crm_deal_get: 'crm.deal.get',
  crm_deal_add: 'crm.deal.add',
  crm_deal_update: 'crm.deal.update',
  crm_contact_list: 'crm.contact.list',
  crm_company_list: 'crm.company.list',
});

const listArgsSchema = {
  type: 'object',
  properties: {
    filter: { type: 'object' },
    select: { type: 'array', items: { type: 'string' } },
    order: { type: 'object' },
    start: { type: 'integer', minimum: 0 },
  },
  additionalProperties: false,
};

const TOOLS = [
  {
    name: 'crm_deal_list',
    description: 'Список сделок CRM Битрикс24 (crm.deal.list).',
    inputSchema: listArgsSchema,
  },
  {
    name: 'crm_deal_get',
    description: 'Получить сделку Битрикс24 по ID (crm.deal.get).',
    inputSchema: {
      type: 'object',
      properties: { id: { type: ['string', 'number'] } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'crm_deal_add',
    description: 'Создать сделку в Битрикс24 (crm.deal.add).',
    inputSchema: {
      type: 'object',
      properties: { fields: { type: 'object' } },
      required: ['fields'],
      additionalProperties: false,
    },
  },
  {
    name: 'crm_deal_update',
    description: 'Обновить сделку Битрикс24 (crm.deal.update).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: ['string', 'number'] },
        fields: { type: 'object' },
      },
      required: ['id', 'fields'],
      additionalProperties: false,
    },
  },
  {
    name: 'crm_contact_list',
    description: 'Список контактов CRM Битрикс24 (crm.contact.list).',
    inputSchema: listArgsSchema,
  },
  {
    name: 'crm_company_list',
    description: 'Список компаний CRM Битрикс24 (crm.company.list).',
    inputSchema: listArgsSchema,
  },
];

function asObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('arguments должен быть объектом');
  }

  return value;
}

function cleanListArgs(args) {
  const input = asObject(args);
  const result = {};

  for (const key of ['filter', 'select', 'order', 'start']) {
    if (input[key] !== undefined) {
      result[key] = input[key];
    }
  }

  if (result.start !== undefined) {
    if (!Number.isInteger(result.start) || result.start < 0) {
      throw new Error('start должен быть целым >= 0');
    }
  }

  return result;
}

export async function callBitrixTool(name, args, options = {}) {
  const method = TOOL_METHODS[name];

  if (method === undefined) {
    throw new Error(`Неизвестный инструмент: ${name}`);
  }

  const base = options.webhookUrl ?? webhookUrl;
  if (!base) {
    throw new Error('BITRIX24_WEBHOOK_URL не задан или некорректен');
  }

  let payload;

  if (name === 'crm_deal_list' || name === 'crm_contact_list' || name === 'crm_company_list') {
    payload = cleanListArgs(args);
  } else if (name === 'crm_deal_get') {
    const input = asObject(args);
    if (input.id === undefined) {
      throw new Error('id обязателен');
    }
    payload = { id: input.id };
  } else if (name === 'crm_deal_add') {
    const input = asObject(args);
    if (typeof input.fields !== 'object' || input.fields === null || Array.isArray(input.fields)) {
      throw new Error('fields должен быть объектом');
    }
    payload = { fields: input.fields };
  } else {
    const input = asObject(args);
    if (input.id === undefined) {
      throw new Error('id обязателен');
    }
    if (typeof input.fields !== 'object' || input.fields === null || Array.isArray(input.fields)) {
      throw new Error('fields должен быть объектом');
    }
    payload = { id: input.id, fields: input.fields };
  }

  const response = await fetch(`${base}${method}.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    redirect: 'error',
    signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
  });
  const text = await response.text();
  let data = null;

  try {
    data = text === '' ? null : JSON.parse(text);
  } catch {
    data = null;
  }

  if (!response.ok || (data !== null && data.error !== undefined)) {
    const description =
      data?.error_description ?? data?.error ?? text.slice(0, 300);
    throw new Error(
      `Битрикс24 HTTP ${response.status}: ${safeDetail(description)}`,
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
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(payload);
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
      const result = await callBitrixTool(name, params.arguments ?? {}, {
        webhookUrl: credentials.webhookUrl,
      });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result),
          },
        ],
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
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

  if (request.method === 'GET' && url.pathname === '/api/health') {
    const configured = webhookUrl !== null;

    if (!configured && !ALLOW_MISSING_KEYS) {
      sendJson(response, 503, {
        status: 'error',
        service: SERVICE_NAME,
        missing: ['BITRIX24_WEBHOOK_URL'],
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
    let sessionWebhook;

    try {
      sessionWebhook = resolveBitrixWebhookFromHeaders(request.headers);
    } catch (error) {
      sendJson(response, 400, {
        status: 'error',
        message: safeDetail(error instanceof Error ? error.message : error),
      });
      return;
    }

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

    sessions.set(sessionId, {
      response,
      heartbeat,
      webhookUrl: sessionWebhook,
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

    let requestWebhook;

    try {
      requestWebhook = resolveBitrixWebhookFromHeaders(
        request.headers,
        session.webhookUrl,
      );
    } catch (error) {
      sendJson(response, 400, {
        status: 'error',
        message: safeDetail(error instanceof Error ? error.message : error),
      });
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

    try {
      const result = await handleRpc(message, {
        webhookUrl: requestWebhook,
      });
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
    console.log(`${SERVICE_NAME} listening on :${PORT} (configured=${webhookUrl !== null})`);
  });
}

export { server, TOOLS };
