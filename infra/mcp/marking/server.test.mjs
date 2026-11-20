import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import {
  callMarkingTool,
  normalizeInn,
  resolveMarkingCredentialsFromHeaders,
  safeDetail,
  TOOLS,
} from './server.mjs';

const CREDS = {
  token: 'true-api-token',
  inn: '7700000000',
  apiUrl: 'https://crpt.ru',
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

function respondJson(response, payload = {}) {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(payload));
}

describe('marking-mcp: креды и маскировка', () => {
  it('в tools/list ровно 3 инструмента', () => {
    assert.deepEqual(
      TOOLS.map((tool) => tool.name),
      [
        'marking_check_codes',
        'marking_document_status',
        'marking_create_discrepancy_draft',
      ],
    );
  });

  it('per-request заголовки перекрывают env, ИНН валидируется', () => {
    assert.deepEqual(
      resolveMarkingCredentialsFromHeaders(
        { 'x-marking-token': ' request-token ', 'x-marking-inn': ' 770000000000 ' },
        CREDS,
      ),
      { token: 'request-token', inn: '770000000000', apiUrl: CREDS.apiUrl },
    );
    assert.equal(normalizeInn('1234567890'), '1234567890');
    assert.throws(() => normalizeInn('123'), /10 или 12 цифр/);
    assert.throws(() => normalizeInn('abcdefghij'), /10 или 12 цифр/);
  });

  it('Bearer-токен и DataMatrix-код не попадают в ошибку', () => {
    const masked = safeDetail(
      'Bearer secret-token cis="010460000000000021ABCDEF" 01 04600000000000',
    );
    assert.ok(!masked.includes('secret-token'));
    assert.ok(!masked.includes('ABCDEF'));
    assert.ok(!masked.includes('04600000000000'));
    assert.match(masked, /\[REDACTED\]/);
  });
});

describe('marking-mcp: инструменты ГИС МТ', () => {
  it('check_codes: POST /cises/info, Bearer и нормализация результата', async () => {
    await withUpstream(
      (_request, response) =>
        respondJson(response, {
          results: [
            {
              cis: '010460000000000021CODE1',
              status: 'INTRODUCED',
              ownerInn: '7700000000',
              productName: 'Молоко',
              gtin: '04600000000001',
              expirationDate: '2027-01-01',
            },
          ],
        }),
      async (port, calls) => {
        const result = await callMarkingTool(
          'marking_check_codes',
          { codes: ['010460000000000021CODE1'] },
          { ...CREDS, apiUrl: `http://127.0.0.1:${port}` },
        );
        assert.deepEqual(result, {
          results: [
            {
              cis: '010460000000000021CODE1',
              status: 'INTRODUCED',
              ownerInn: '7700000000',
              productName: 'Молоко',
              gtin: '04600000000001',
              expirationDate: '2027-01-01',
            },
          ],
        });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].method, 'POST');
        assert.equal(calls[0].path, '/cises/info');
        assert.equal(calls[0].headers.authorization, 'Bearer true-api-token');
        assert.deepEqual(JSON.parse(calls[0].body), {
          cises: ['010460000000000021CODE1'],
          inn: '7700000000',
        });
      },
    );
  });

  it('document_status: GET /doc/:docId/info', async () => {
    await withUpstream(
      (_request, response) => respondJson(response, { docId: 'doc-1', status: 'ACCEPTED' }),
      async (port, calls) => {
        const result = await callMarkingTool(
          'marking_document_status',
          { docId: 'doc 1' },
          { ...CREDS, apiUrl: `http://127.0.0.1:${port}` },
        );
        assert.deepEqual(result, { docId: 'doc-1', status: 'ACCEPTED' });
        assert.equal(calls[0].method, 'GET');
        assert.equal(calls[0].path, '/doc/doc%201/info');
        assert.equal(calls[0].headers.authorization, 'Bearer true-api-token');
      },
    );
  });

  it('create_discrepancy_draft: локальный черновик без отправки и подписи', async () => {
    const draft = await callMarkingTool(
      'marking_create_discrepancy_draft',
      {
        docId: 'doc-1',
        discrepancies: [{ cis: '010460000000000021CODE1', reason: 'нет в накладной' }],
      },
      CREDS,
    );
    assert.deepEqual(draft, {
      draftOnly: true,
      submitted: false,
      signed: false,
      docId: 'doc-1',
      inn: '7700000000',
      discrepancies: [{ cis: '010460000000000021CODE1', reason: 'нет в накладной' }],
    });
  });

  it('неизвестный инструмент и невалидные аргументы отвергаются', async () => {
    await assert.rejects(
      () => callMarkingTool('marking_unknown', {}, CREDS),
      /Неизвестный инструмент/,
    );
    await assert.rejects(
      () => callMarkingTool('marking_check_codes', { codes: [] }, CREDS),
      /codes/,
    );
    await assert.rejects(
      () => callMarkingTool('marking_document_status', {}, CREDS),
      /docId/,
    );
  });

  it('повторяет запрос один раз при 429', async () => {
    let attempts = 0;
    await withUpstream(
      (_request, response) => {
        attempts += 1;
        if (attempts === 1) {
          response.statusCode = 429;
          response.end('{}');
          return;
        }
        respondJson(response, { results: [] });
      },
      async (port) => {
        const result = await callMarkingTool(
          'marking_check_codes',
          { codes: ['code-1'] },
          { ...CREDS, apiUrl: `http://127.0.0.1:${port}` },
        );
        assert.deepEqual(result, { results: [] });
      },
    );
    assert.equal(attempts, 2);
  });
});
