import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import {
  call1CTool,
  normalizeODataUrl,
  resolve1CCredentialsFromHeaders,
  TOOLS,
} from './server.mjs';

const FALLBACK = {
  odataUrl: 'https://1c.example.com/base/odata/standard.odata',
  username: 'env-user',
  password: 'env-pass',
};

async function withUpstream(handler, run) {
  /** @type {Array<{ path: string, method: string, authorization: string, accept: string, body: string }>} */
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
        authorization: String(request.headers.authorization ?? ''),
        accept: String(request.headers.accept ?? ''),
        body,
      });
      handler(request, response, calls);
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}/base/odata/standard.odata`;

  try {
    await run(baseUrl, calls);
  } finally {
    await new Promise((resolve) => upstream.close(resolve));
  }
}

function respondJson(response, payload = { value: [] }) {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(payload));
}

describe('1c-mcp: креды и валидация URL', () => {
  it('берёт креды из X-1C-* заголовков с fallback на env', () => {
    assert.deepEqual(
      resolve1CCredentialsFromHeaders(
        {
          'x-1c-odata-url': ' https://tenant.example.com/odata/standard.odata ',
          'x-1c-username': ' request-user ',
          'x-1c-password': 'request-pass',
        },
        FALLBACK,
      ),
      {
        odataUrl: 'https://tenant.example.com/odata/standard.odata',
        username: 'request-user',
        password: 'request-pass',
      },
    );
    assert.deepEqual(resolve1CCredentialsFromHeaders({}, FALLBACK), FALLBACK);
  });

  it('принимает корректный OData URL и убирает завершающий слэш', () => {
    assert.equal(
      normalizeODataUrl('http://1c.local:8080/base/odata/standard.odata/'),
      'http://1c.local:8080/base/odata/standard.odata',
    );
  });

  it('отвергает URL без /odata/standard.odata, с userinfo и query', () => {
    assert.throws(() => normalizeODataUrl('https://1c.example.com/base'), /standard\.odata/);
    assert.throws(
      () => normalizeODataUrl('https://user:pass@1c.example.com/odata/standard.odata'),
      /логин\/пароль/,
    );
    assert.throws(
      () => normalizeODataUrl('https://1c.example.com/odata/standard.odata?x=1'),
      /query/,
    );
    assert.throws(() => normalizeODataUrl('ftp://1c.example.com/odata/standard.odata'), /http/);
  });

  it('в tools/list ровно 4 инструмента 1С', () => {
    assert.deepEqual(
      TOOLS.map((tool) => tool.name),
      [
        '1c_nomenclature_list',
        '1c_stock_balance',
        '1c_counterparty_debt',
        '1c_customer_order_create',
      ],
    );
  });
});

describe('1c-mcp: вызовы инструментов', () => {
  it('nomenclature: GET Catalog_Номенклатура с $top и $filter по поиску', async () => {
    await withUpstream(
      (_request, response) => respondJson(response, { value: [{ Ref_Key: 'r1' }] }),
      async (odataUrl, calls) => {
        const result = await call1CTool(
          '1c_nomenclature_list',
          { search: 'Кур' + "'ьер", limit: 5 },
          {
            odataUrl,
            username: 'request-user',
            password: 'request-pass',
          },
        );
        assert.deepEqual(result, { value: [{ Ref_Key: 'r1' }] });

        assert.equal(calls.length, 1);
        assert.equal(calls[0].method, 'GET');
        const url = new URL(calls[0].path, 'http://localhost');
        assert.equal(decodeURIComponent(url.pathname), '/base/odata/standard.odata/Catalog_Номенклатура');
        assert.equal(url.searchParams.get('$format'), 'json');
        assert.equal(url.searchParams.get('$top'), '5');
        assert.match(url.searchParams.get('$filter') ?? '', /substringof/);
        // Кавычка в поиске экранируется, но не ломает OData-строку.
        assert.match(url.searchParams.get('$filter') ?? '', /Кур''ьер/);
        assert.equal(
          calls[0].authorization,
          `Basic ${Buffer.from('request-user:request-pass').toString('base64')}`,
        );
        assert.equal(calls[0].accept, 'application/json');
      },
    );
  });

  it('stock_balance: GET AccumulationRegister_ТоварыНаСкладах/Balance', async () => {
    await withUpstream(
      (_request, response) => respondJson(response),
      async (odataUrl, calls) => {
        await call1CTool(
          '1c_stock_balance',
          { filter: "Склад/Description eq 'Основной'", limit: 10 },
          { ...FALLBACK, odataUrl },
        );
        const url = new URL(calls[0].path, 'http://localhost');
        assert.equal(
          decodeURIComponent(url.pathname),
          '/base/odata/standard.odata/AccumulationRegister_ТоварыНаСкладах/Balance',
        );
        assert.equal(url.searchParams.get('$top'), '10');
        assert.equal(url.searchParams.get('$filter'), "Склад/Description eq 'Основной'");
      },
    );
  });

  it('counterparty_debt: GET ВзаиморасчетыСКонтрагентами/Balance с ИНН', async () => {
    await withUpstream(
      (_request, response) => respondJson(response),
      async (odataUrl, calls) => {
        await call1CTool(
          '1c_counterparty_debt',
          { inn: '7700000000' },
          { ...FALLBACK, odataUrl },
        );
        const url = new URL(calls[0].path, 'http://localhost');
        assert.equal(
          decodeURIComponent(url.pathname),
          '/base/odata/standard.odata/AccumulationRegister_ВзаиморасчетыСКонтрагентами/Balance',
        );
        assert.equal(url.searchParams.get('$filter'), "Контрагент/ИНН eq '7700000000'");
      },
    );
  });

  it('customer_order_create: POST Document_ЗаказПокупателя с JSON-телом', async () => {
    await withUpstream(
      (_request, response) => respondJson(response, { Ref_Key: 'doc-1' }),
      async (odataUrl, calls) => {
        const result = await call1CTool(
          '1c_customer_order_create',
          { payload: { Наименование: 'Заказ 1' } },
          { ...FALLBACK, odataUrl },
        );
        assert.deepEqual(result, { Ref_Key: 'doc-1' });
        assert.equal(calls[0].method, 'POST');
        const url = new URL(calls[0].path, 'http://localhost');
        assert.equal(decodeURIComponent(url.pathname), '/base/odata/standard.odata/Document_ЗаказПокупателя');
        assert.equal(url.searchParams.get('$format'), 'json');
        assert.deepEqual(JSON.parse(calls[0].body), { Наименование: 'Заказ 1' });
      },
    );
  });

  it('неизвестный инструмент и невалидный payload отвергаются', async () => {
    await assert.rejects(() => call1CTool('1c_unknown', {}, FALLBACK), /Неизвестный инструмент/);
    await assert.rejects(
      () => call1CTool('1c_customer_order_create', { payload: 'not-object' }, FALLBACK),
      /payload/,
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
        respondJson(response, { value: [] });
      },
      async (odataUrl) => {
        const result = await call1CTool('1c_stock_balance', {}, { ...FALLBACK, odataUrl });
        assert.deepEqual(result, { value: [] });
      },
    );
    assert.equal(attempts, 2);
  });
});
