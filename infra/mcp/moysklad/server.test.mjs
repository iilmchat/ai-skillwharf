import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import {
  callMoySkladTool,
  resolveMoyskladTokenFromHeaders,
} from './server.mjs';

async function withUpstream(handler, run) {
  const upstream = createServer(handler);
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');

  try {
    await run(`http://127.0.0.1:${address.port}/api/remap/1.2`);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
}

describe('moysklad-mcp per-request credentials и новые методы', () => {
  it('берёт токен из X-Moysklad-Token с fallback на env', () => {
    assert.equal(
      resolveMoyskladTokenFromHeaders(
        { 'x-moysklad-token': ' request-token ' },
        'env-token',
      ),
      'request-token',
    );
    assert.equal(resolveMoyskladTokenFromHeaders({}, 'env-token'), 'env-token');
    assert.equal(resolveMoyskladTokenFromHeaders({}, null), '');
  });

  it('создаёт отгрузку и заказ поставщику с per-request токеном', async () => {
    const calls = [];

    await withUpstream(
      (request, response) => {
        let body = '';
        request.on('data', (chunk) => {
          body += chunk;
        });
        request.on('end', () => {
          calls.push({
            path: request.url ?? '',
            method: request.method ?? '',
            authorization: request.headers.authorization ?? '',
            body,
          });
          response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ id: 'created' }));
        });
      },
      async (baseUrl) => {
        await callMoySkladTool(
          'demand_create',
          { payload: { name: 'ДОтгрузка-1' } },
          { token: 'request-token', baseUrl },
        );
        await callMoySkladTool(
          'purchase_order_create',
          { payload: { name: 'Заказ-поставщику-1' } },
          { token: 'request-token', baseUrl },
        );
      },
    );

    assert.equal(calls.length, 2);
    assert.deepEqual(
      calls.map((call) => [call.method, call.path]),
      [
        ['POST', '/api/remap/1.2/entity/demand'],
        ['POST', '/api/remap/1.2/entity/purchaseorder'],
      ],
    );
    for (const call of calls) {
      assert.equal(call.authorization, 'Bearer request-token');
    }
  });

  it('читает баланс контрагента и состав комплекта с пагинацией', async () => {
    const calls = [];

    await withUpstream(
      (request, response) => {
        calls.push(request.url ?? '');
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ rows: [{ id: 'row-1' }] }));
      },
      async (baseUrl) => {
        await callMoySkladTool(
          'counterparty_balance',
          { filter: 'name=ООО Ромашка', limit: 5, offset: 10 },
          { token: 'request-token', baseUrl },
        );
        await callMoySkladTool(
          'bundle_get',
          { id: 'bundle-1' },
          { token: 'request-token', baseUrl },
        );
        await callMoySkladTool(
          'bundle_get',
          { article: 'SKU-1' },
          { token: 'request-token', baseUrl },
        );
      },
    );

    assert.equal(calls[0], '/api/remap/1.2/report/counterparty?limit=5&offset=10&filter=name%3D%D0%9E%D0%9E%D0%9E+%D0%A0%D0%BE%D0%BC%D0%B0%D1%88%D0%BA%D0%B0');
    assert.equal(calls[1], '/api/remap/1.2/entity/bundle/bundle-1');
    assert.equal(calls[2], '/api/remap/1.2/entity/bundle?filter=article%3DSKU-1&limit=1');
  });

  it('повторяет запрос при 429 с экспоненциальной задержкой', async () => {
    let attempts = 0;

    await withUpstream(
      (_request, response) => {
        attempts += 1;
        if (attempts === 1) {
          response.statusCode = 429;
          response.end('{}');
          return;
        }
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ rows: [] }));
      },
      async (baseUrl) => {
        const result = await callMoySkladTool(
          'product_list',
          { limit: 1 },
          { token: 'request-token', baseUrl },
        );
        assert.deepEqual(result, { rows: [] });
      },
    );

    assert.equal(attempts, 2);
  });
});
