import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import {
  callEdoTool,
  normalizeProvider,
  resolveEdoCredentialsFromHeaders,
  safeDetail,
  TOOLS,
} from './server.mjs';

const DIADOC = {
  provider: 'diadoc',
  apiKey: 'dd-key',
  token: 'dd-token',
  boxId: 'box-1',
  diadocUrl: 'https://kontur.ru',
  sbisUrl: 'https://sbis.ru',
};

const SBIS = {
  provider: 'sbis',
  apiKey: '',
  token: 'sbis-session',
  boxId: '7700000000/0001',
  diadocUrl: 'https://kontur.ru',
  sbisUrl: 'https://sbis.ru',
};

async function withUpstream(handler, run) {
  /** @type {Array<{ path: string, method: string, headers: Record<string, unknown>, body: string }>} */
  const calls = [];
  const upstream = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      calls.push({
        path: request.url ?? '',
        method: request.method ?? '',
        headers: { ...request.headers },
        body,
      });
      handler(request, response);
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;

  try {
    await run(port, calls);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
}

function respondJson(response, payload = { value: [] }) {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(payload));
}

describe('edo-mcp: креды и маскировка секретов', () => {
  it('все 4 инструмента присутствуют в tools/list', () => {
    assert.deepEqual(
      TOOLS.map((tool) => tool.name),
      [
        'edo_list_incoming_documents',
        'edo_get_document_details',
        'edo_prepare_sign_packet',
        'edo_reject_document',
      ],
    );
  });

  it('per-request заголовки перекрывают env, провайдер нормализуется', () => {
    assert.deepEqual(
      resolveEdoCredentialsFromHeaders(
        {
          'x-edo-provider': ' SBIS ',
          'x-edo-token': ' request-session ',
          'x-edo-box-id': ' 123/1 ',
          'x-edo-api-key': ' key ',
        },
        DIADOC,
      ),
      {
        provider: 'sbis',
        apiKey: 'key',
        token: 'request-session',
        boxId: '123/1',
        diadocUrl: DIADOC.diadocUrl,
        sbisUrl: DIADOC.sbisUrl,
      },
    );
    assert.equal(normalizeProvider('diadoc'), 'diadoc');
    assert.throws(() => normalizeProvider('saby'), /diadoc или sbis/);
  });

  it('токены и ключи не попадают в текст ошибки', () => {
    const masked = safeDetail(
      'DiadocAuth ddauth_api_client_id=secret-id,ddauth_token=secret-token ' +
        'X-SBISSessionID: sbis-secret',
    );
    assert.ok(!masked.includes('secret-id'));
    assert.ok(!masked.includes('secret-token'));
    assert.ok(!masked.includes('sbis-secret'));
    assert.match(masked, /\[REDACTED\]/);
  });
});

describe('edo-mcp: провайдер Диадок', () => {
  it('list: GET V3/GetDocuments с фильтром входящих и DiadocAuth', async () => {
    await withUpstream(
      (_request, response) => respondJson(response, { Documents: [] }),
      async (port, calls) => {
        const result = await callEdoTool(
          'edo_list_incoming_documents',
          { limit: 5 },
          { ...DIADOC, diadocUrl: `http://127.0.0.1:${port}` },
        );
        assert.deepEqual(result, { Documents: [] });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].method, 'GET');
        const url = new URL(calls[0].path, 'http://localhost');
        assert.equal(url.pathname, '/V3/GetDocuments');
        assert.equal(url.searchParams.get('boxId'), 'box-1');
        assert.equal(url.searchParams.get('filterCategory'), 'Any.InboundNotFinished');
        assert.match(
          String(calls[0].headers.authorization),
          /DiadocAuth ddauth_api_client_id=dd-key,ddauth_token=dd-token/,
        );
      },
    );
  });

  it('details: GET V3/GetDocument с documentId', async () => {
    await withUpstream(
      (_request, response) =>
        respondJson(response, { documentId: 'doc-1', items: [{ name: 'Товар', price: 10 }] }),
      async (port, calls) => {
        await callEdoTool(
          'edo_get_document_details',
          { documentId: 'doc-1', messageId: 'msg-9' },
          { ...DIADOC, diadocUrl: `http://127.0.0.1:${port}` },
        );
        const url = new URL(calls[0].path, 'http://localhost');
        assert.equal(url.pathname, '/V3/GetDocument');
        assert.equal(url.searchParams.get('documentId'), 'doc-1');
        assert.equal(url.searchParams.get('messageId'), 'msg-9');
        assert.equal(url.searchParams.get('boxId'), 'box-1');
      },
    );
  });

  it('prepare_sign_packet: локальный пакет без криптоподписи', async () => {
    const packet = await callEdoTool(
      'edo_prepare_sign_packet',
      { documentId: 'doc-1', signer: 'Иванов И.И.' },
      DIADOC,
    );
    assert.deepEqual(packet, {
      provider: 'diadoc',
      boxId: 'box-1',
      documentId: 'doc-1',
      titleType: 'BuyerTitle',
      signer: 'Иванов И.И.',
      comment: null,
      unsigned: true,
    });
  });

  it('reject: POST SendAmendmentRequest с причиной', async () => {
    await withUpstream(
      (_request, response) => respondJson(response, { ok: true }),
      async (port, calls) => {
        await callEdoTool(
          'edo_reject_document',
          { documentId: 'doc-1', reason: 'цена не совпадает' },
          { ...DIADOC, diadocUrl: `http://127.0.0.1:${port}` },
        );
        assert.equal(calls[0].method, 'POST');
        assert.equal(calls[0].path, '/V3/SendAmendmentRequest');
        assert.deepEqual(JSON.parse(calls[0].body), {
          boxId: 'box-1',
          documentId: 'doc-1',
          reason: 'цена не совпадает',
        });
      },
    );
  });
});

describe('edo-mcp: провайдер СБИС', () => {
  it('list: JSON-RPC СБИС.СписокДокументов и X-SBISSessionID', async () => {
    await withUpstream(
      (_request, response) => respondJson(response, { result: { docs: [] } }),
      async (port, calls) => {
        const result = await callEdoTool(
          'edo_list_incoming_documents',
          { limit: 3 },
          { ...SBIS, sbisUrl: `http://127.0.0.1:${port}` },
        );
        assert.deepEqual(result, { result: { docs: [] } });
        assert.equal(calls[0].method, 'POST');
        assert.equal(calls[0].path, '/jsonrpc');
        assert.equal(calls[0].headers['x-sbissessionid'], 'sbis-session');
        const body = JSON.parse(calls[0].body);
        assert.equal(body.method, 'СБИС.СписокДокументов');
        assert.equal(body.params.boxId, '7700000000/0001');
        assert.equal(body.params.limit, 3);
      },
    );
  });

  it('reject: JSON-RPC СБИС.ОтклонитьДокумент с причиной', async () => {
    await withUpstream(
      (_request, response) => respondJson(response, { result: true }),
      async (port, calls) => {
        await callEdoTool(
          'edo_reject_document',
          { documentId: 'doc-2', reason: 'расхождение номенклатуры' },
          { ...SBIS, sbisUrl: `http://127.0.0.1:${port}` },
        );
        const body = JSON.parse(calls[0].body);
        assert.equal(body.method, 'СБИС.ОтклонитьДокумент');
        assert.equal(body.params.documentId, 'doc-2');
        assert.equal(body.params.reason, 'расхождение номенклатуры');
      },
    );
  });

  it('prepare_sign_packet для СБИС использует СБИС.ПодготовитьПодпись', async () => {
    await withUpstream(
      (_request, response) => respondJson(response, { result: { packetId: 'p1' } }),
      async (port, calls) => {
        await callEdoTool(
          'edo_prepare_sign_packet',
          { documentId: 'doc-3' },
          { ...SBIS, sbisUrl: `http://127.0.0.1:${port}` },
        );
        const body = JSON.parse(calls[0].body);
        assert.equal(body.method, 'СБИС.ПодготовитьПодпись');
        assert.equal(body.params.decision, 'approve');
      },
    );
  });

  it('неизвестный инструмент и отсутствие обязательных полей отвергаются', async () => {
    await assert.rejects(() => callEdoTool('edo_unknown', {}, DIADOC), /Неизвестный инструмент/);
    await assert.rejects(
      () => callEdoTool('edo_reject_document', { documentId: 'doc-1' }, DIADOC),
      /reason/,
    );
  });

  it('повторяет один раз при 429', async () => {
    let attempts = 0;
    await withUpstream(
      (_request, response) => {
        attempts += 1;
        if (attempts === 1) {
          response.statusCode = 429;
          response.end('{}');
          return;
        }
        respondJson(response, { Documents: [] });
      },
      async (port) => {
        const result = await callEdoTool(
          'edo_list_incoming_documents',
          {},
          { ...DIADOC, diadocUrl: `http://127.0.0.1:${port}` },
        );
        assert.deepEqual(result, { Documents: [] });
      },
    );
    assert.equal(attempts, 2);
  });
});
