import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import nock from 'nock';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { ApiException } from '../../common/api-error.js';
import { ERROR_KEYS } from '../../i18n/error-keys.js';
import {
  bitrix24GetDeal,
  bitrix24UpdateDeal,
  isFinalDealStage,
  moyskladCheckStock,
  moyskladCreateOrder,
  moyskladGetCost,
} from './erp-tools.js';
import { MarketplaceMcpService } from './marketplace-mcp.service.js';

/**
 * Инструменты Треков K/L против настоящих MCP-серверов (Треки K/L) с
 * nock-эмуляцией REST-ответов Битрикс24 и МойСклад.
 *
 * Цепочка в тесте ровно та же, что в бою: инструмент → `MarketplaceMcpService`
 * → MCP-клиент (HTTP/SSE) → MCP-сервер `infra/mcp/*` → REST API провайдера.
 * Наружу выходят только запросы к провайдерам, и их перехватывает nock:
 * поэтому проверяются реальные пути, тела запросов и разбор ответов, а не
 * заглушки. Сценарии 401/429 проверяются на двух уровнях — транспорт MCP и
 * ошибка провайдера внутри JSON-RPC.
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

const BITRIX_WEBHOOK = 'https://portal.bitrix24.ru/rest/1/token/';
const BITRIX_API = 'https://portal.bitrix24.ru';
const MOYSKLAD_API = 'https://api.moysklad.ru';
const MOYSKLAD_REMAP = '/api/remap/1.2';
const MOYSKLAD_ORGANIZATION_ID = 'organization-1';
const MOYSKLAD_AGENT_ID = 'counterparty-1';

/** MCP-серверы, поднятые в процессе теста. */
const servers: Server[] = [];
let bitrixMcpUrl = '';
let moyskladMcpUrl = '';

/** Загружает MCP-сервер из `infra/mcp` (env читается при импорте). */
async function loadMcpServer(relativePath: string): Promise<Server> {
  const url = pathToFileURL(join(REPO_ROOT, relativePath)).href;
  const module = (await import(/* @vite-ignore */ url)) as { server: Server };

  return module.server;
}

/** Слушает сервер на свободном порту localhost и возвращает его URL. */
async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address() as AddressInfo;

  return `http://127.0.0.1:${address.port}`;
}

beforeAll(async () => {
  process.env.BITRIX24_WEBHOOK_URL = BITRIX_WEBHOOK;
  process.env.MOYSKLAD_TOKEN = 'moysklad-test-token';
  // Конфигурация MCP-сервера читается при импорте: фиксируем базовый URL
  // JSON API, чтобы nock-моки и подсказки ссылок совпадали.
  delete process.env.MOYSKLAD_BASE_URL;
  delete process.env.MCP_AUTH_TOKEN;

  const bitrix = await loadMcpServer('infra/mcp/bitrix24/server.mjs');
  const moysklad = await loadMcpServer('infra/mcp/moysklad/server.mjs');

  servers.push(bitrix, moysklad);
  bitrixMcpUrl = await listen(bitrix);
  moyskladMcpUrl = await listen(moysklad);
});

afterAll(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  delete process.env.BITRIX24_WEBHOOK_URL;
  delete process.env.MOYSKLAD_TOKEN;
});

beforeEach(() => {
  // Секреты провайдеров в API не нужны: их читает MCP-контейнер.
  delete process.env.BITRIX24_MCP_URL;
  delete process.env.MOYSKLAD_MCP_URL;
  // Заказ покупателя требует организацию и контрагента (KI-080).
  process.env.MOYSKLAD_DEFAULT_ORGANIZATION_ID = MOYSKLAD_ORGANIZATION_ID;
  process.env.MOYSKLAD_DEFAULT_AGENT_ID = MOYSKLAD_AGENT_ID;
  process.env.MOYSKLAD_BASE_URL = `${MOYSKLAD_API}${MOYSKLAD_REMAP}`;
  nock.disableNetConnect();
  // MCP-серверы слушают localhost: их запросы пропускаем, всё остальное
  // должно быть замокано.
  nock.enableNetConnect('127.0.0.1');
});

afterEach(() => {
  nock.cleanAll();
  nock.enableNetConnect();
  delete process.env.MOYSKLAD_DEFAULT_ORGANIZATION_ID;
  delete process.env.MOYSKLAD_DEFAULT_AGENT_ID;
  delete process.env.MOYSKLAD_BASE_URL;
});

/** Новый сервис на каждый тест: у него свой кеш MCP-клиентов. */
function createService(): MarketplaceMcpService {
  return new MarketplaceMcpService();
}

/** Ожидаемая ошибка единого формата API. */
async function captureApiError(
  promise: Promise<unknown>,
): Promise<ApiException> {
  const error: unknown = await promise.catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(ApiException);

  return error as ApiException;
}

describe('bitrix24-crm: реальные MCP-серверы + nock на REST Битрикс24', () => {
  it('bitrix24_get_deal читает сделку и нормализует ответ', async () => {
    const api = nock(BITRIX_API)
      .post('/rest/1/token/crm.deal.get.json', { id: '42' })
      .reply(200, {
        result: {
          ID: '42',
          TITLE: 'Поставка кресел',
          STAGE_ID: 'WON',
          OPPORTUNITY: '150000',
          CURRENCY_ID: 'RUB',
          COMMENTS: 'Оплачено',
          COMPANY_ID: '7',
        },
        time: {},
      });

    const result = await bitrix24GetDeal(
      createService(),
      { dealId: '42' },
      { endpoint: bitrixMcpUrl },
    );

    expect(JSON.parse(result)).toMatchObject({
      dealId: '42',
      title: 'Поставка кресел',
      stageId: 'WON',
      stageFinal: true,
      amount: 150000,
      currency: 'RUB',
      comments: 'Оплачено',
      companyId: '7',
    });
    expect(api.isDone()).toBe(true);
  });

  it('bitrix24_update_deal отправляет стадию и комментарий в fields', async () => {
    const api = nock(BITRIX_API)
      .post('/rest/1/token/crm.deal.update.json', {
        id: '42',
        fields: { STAGE_ID: 'C1:WON', COMMENTS: 'Готово' },
      })
      .reply(200, { result: true, time: {} });

    const result = await bitrix24UpdateDeal(
      createService(),
      { dealId: '42', stageId: 'C1:WON', comments: 'Готово' },
      { endpoint: bitrixMcpUrl },
    );

    expect(JSON.parse(result)).toMatchObject({
      dealId: '42',
      updated: true,
      stageId: 'C1:WON',
      finalStage: true,
      commentsUpdated: true,
    });
    expect(api.isDone()).toBe(true);
  });

  it('bitrix24_update_deal без stageId не трогает стадию', async () => {
    const api = nock(BITRIX_API)
      .post('/rest/1/token/crm.deal.update.json', {
        id: '42',
        fields: { COMMENTS: 'Только комментарий' },
      })
      .reply(200, { result: true, time: {} });

    const result = await bitrix24UpdateDeal(
      createService(),
      { dealId: '42', comments: 'Только комментарий' },
      { endpoint: bitrixMcpUrl },
    );

    expect(JSON.parse(result)).toMatchObject({
      updated: true,
      finalStage: false,
      commentsUpdated: true,
    });
    expect(api.isDone()).toBe(true);
  });

  it('401 Битрикс24 внутри JSON-RPC сохраняет HTTP-статус в ошибке', async () => {
    nock(BITRIX_API)
      .post('/rest/1/token/crm.deal.get.json')
      .reply(401, {
        error: 'invalid_credentials',
        error_description: 'webhook истёк',
      });

    const error = await captureApiError(
      bitrix24GetDeal(
        createService(),
        { dealId: '42' },
        {
          endpoint: bitrixMcpUrl,
        },
      ),
    );

    expect(error.getResponse()).toMatchObject({
      statusCode: 502,
      code: ERROR_KEYS.mcpProvider,
    });
    expect((error as Error).message).toContain('HTTP 401');
  });

  it('429 Битрикс24 (лимит 2 запроса в секунду) даёт 502 без ретрая', async () => {
    const api = nock(BITRIX_API)
      .post('/rest/1/token/crm.deal.get.json')
      .reply(429, { error: 'too_many_requests' });

    const error = await captureApiError(
      bitrix24GetDeal(
        createService(),
        { dealId: '42' },
        {
          endpoint: bitrixMcpUrl,
        },
      ),
    );

    expect(error.getResponse()).toMatchObject({
      statusCode: 502,
      code: ERROR_KEYS.mcpProvider,
    });
    expect((error as Error).message).toContain('HTTP 429');
    expect(api.isDone()).toBe(true);
  });

  it('транспорт MCP: 401 на /sse маппится в 502 errors.mcp_provider', async () => {
    nock('http://bitrix24-mcp.test').get('/sse').reply(401, {
      status: 'error',
      message: 'unauthorized',
    });

    const error = await captureApiError(
      bitrix24GetDeal(
        createService(),
        { dealId: '42' },
        {
          endpoint: 'http://bitrix24-mcp.test',
        },
      ),
    );

    expect(error.getResponse()).toMatchObject({
      statusCode: 502,
      code: ERROR_KEYS.mcpProvider,
    });
  });

  it('без endpoint MCP-сервера отдаёт 503 marketplace_unavailable', async () => {
    const error = await captureApiError(
      bitrix24GetDeal(createService(), { dealId: '42' }),
    );

    expect(error.getResponse()).toMatchObject({
      statusCode: 503,
      code: ERROR_KEYS.marketplaceUnavailable,
    });
    expect((error as Error).message).toContain('BITRIX24_MCP_URL');
  });
});

describe('moysklad-warehouse: реальные MCP-серверы + nock на JSON API', () => {
  it('moysklad_check_stock вычитает резерв и сравнивает с запросом', async () => {
    nock(MOYSKLAD_API)
      .get(`${MOYSKLAD_REMAP}/entity/product/product-1`)
      .reply(200, {
        id: 'product-1',
        name: 'Кресло офисное',
        article: 'CH-1',
        stock: 12,
        reserve: 5,
        meta: {
          href: `${MOYSKLAD_API}${MOYSKLAD_REMAP}/entity/product/product-1`,
        },
      });
    nock(MOYSKLAD_API)
      .get(`${MOYSKLAD_REMAP}/report/stock/all`)
      .query({ filter: 'article=CH-1', limit: 100 })
      .reply(200, [
        { article: 'CH-1', warehouse: { name: 'Основной склад' }, stock: 10 },
        { article: 'CH-1', warehouse: 'Резервный склад', stock: 2 },
      ]);

    const result = await moyskladCheckStock(
      createService(),
      { productId: 'product-1', quantity: 8 },
      { endpoint: moyskladMcpUrl },
    );

    expect(JSON.parse(result)).toMatchObject({
      productId: 'product-1',
      tracked: true,
      onHand: 12,
      reserve: 5,
      available: 7,
      requested: 8,
      enough: false,
      warehouses: [
        { name: 'Основной склад', stock: 10 },
        { name: 'Резервный склад', stock: 2 },
      ],
    });
  });

  it('moysklad_check_stock: услуга без stock — tracked:false, без ошибки', async () => {
    nock(MOYSKLAD_API)
      .get(`${MOYSKLAD_REMAP}/entity/product/service-1`)
      .reply(200, {
        id: 'service-1',
        name: 'Доставка',
      });

    const result = await moyskladCheckStock(
      createService(),
      { productId: 'service-1', quantity: 1 },
      { endpoint: moyskladMcpUrl },
    );

    expect(JSON.parse(result)).toEqual({
      productId: 'service-1',
      tracked: false,
      available: true,
      stock: null,
      reserve: null,
      reason: 'untracked_item',
    });
  });

  it('moysklad_check_stock: недоступный stock_report — fallback на остаток карточки', async () => {
    nock(MOYSKLAD_API)
      .get(`${MOYSKLAD_REMAP}/entity/product/product-1`)
      .reply(200, {
        id: 'product-1',
        name: 'Кресло офисное',
        article: 'CH-1',
        stock: 12,
        reserve: 5,
      });
    nock(MOYSKLAD_API)
      .get(`${MOYSKLAD_REMAP}/report/stock/all`)
      .query({ filter: 'article=CH-1', limit: 100 })
      .reply(500, { errors: [{ error: 'report unavailable' }] });

    const result = await moyskladCheckStock(
      createService(),
      { productId: 'product-1', quantity: 1 },
      { endpoint: moyskladMcpUrl },
    );

    expect(JSON.parse(result)).toMatchObject({
      onHand: 12,
      reserve: 5,
      available: 7,
      warehouses: [],
    });
  });

  it('moysklad_get_cost переводит закупочную цену из копеек в рубли', async () => {
    nock(MOYSKLAD_API)
      .get(`${MOYSKLAD_REMAP}/entity/product/product-1`)
      .reply(200, {
        id: 'product-1',
        name: 'Кресло офисное',
        buyPrice: { value: 45000 },
      });

    const result = await moyskladGetCost(
      createService(),
      { productId: 'product-1' },
      { endpoint: moyskladMcpUrl },
    );

    expect(JSON.parse(result)).toMatchObject({
      productId: 'product-1',
      cost: 450,
      currency: 'RUB',
      source: 'buyPrice',
    });
  });

  it('moysklad_get_cost без закупочной цены — понятная ошибка провайдера', async () => {
    nock(MOYSKLAD_API)
      .get(`${MOYSKLAD_REMAP}/entity/product/product-1`)
      .reply(200, { id: 'product-1', name: 'Кресло офисное' });

    const error = await captureApiError(
      moyskladGetCost(
        createService(),
        { productId: 'product-1' },
        {
          endpoint: moyskladMcpUrl,
        },
      ),
    );

    expect(error.getResponse()).toMatchObject({
      statusCode: 502,
      code: ERROR_KEYS.mcpProvider,
    });
    expect((error as Error).message).toContain('себестоимость');
  });

  it('moysklad_create_order собирает позиции и создаёт заказ покупателя', async () => {
    nock(MOYSKLAD_API)
      .get(`${MOYSKLAD_REMAP}/entity/product/product-1`)
      .reply(200, {
        id: 'product-1',
        meta: {
          href: `${MOYSKLAD_API}${MOYSKLAD_REMAP}/entity/product/product-1`,
        },
        salePrices: [{ value: 120000 }],
      });

    const order = nock(MOYSKLAD_API)
      .post(`${MOYSKLAD_REMAP}/entity/customerorder`, {
        description: 'Заказ по сделке Битрикс24 #42',
        organization: {
          meta: {
            href: `${MOYSKLAD_API}${MOYSKLAD_REMAP}/entity/organization/${MOYSKLAD_ORGANIZATION_ID}`,
            type: 'organization',
            mediaType: 'application/json',
          },
        },
        agent: {
          meta: {
            href: `${MOYSKLAD_API}${MOYSKLAD_REMAP}/entity/counterparty/${MOYSKLAD_AGENT_ID}`,
            type: 'counterparty',
            mediaType: 'application/json',
          },
        },
        positions: [
          {
            quantity: 2,
            price: 120000,
            assortment: {
              meta: {
                href: `${MOYSKLAD_API}${MOYSKLAD_REMAP}/entity/product/product-1`,
                type: 'product',
                mediaType: 'application/json',
              },
            },
          },
        ],
      })
      .reply(200, {
        id: 'order-1',
        name: 'Заказ покупателя №1',
        sum: 240000,
      });

    const result = await moyskladCreateOrder(
      createService(),
      { dealId: '42', items: [{ productId: 'product-1', quantity: 2 }] },
      { endpoint: moyskladMcpUrl },
    );

    expect(JSON.parse(result)).toMatchObject({
      orderId: 'order-1',
      orderName: 'Заказ покупателя №1',
      dealId: '42',
      positions: 1,
      sum: 2400,
    });
    expect(order.isDone()).toBe(true);
  });

  it('429 МойСклада на создание заказа — 502 с HTTP-статусом', async () => {
    nock(MOYSKLAD_API)
      .get(`${MOYSKLAD_REMAP}/entity/product/product-1`)
      .reply(200, {
        id: 'product-1',
        meta: {
          href: `${MOYSKLAD_API}${MOYSKLAD_REMAP}/entity/product/product-1`,
        },
        salePrices: [{ value: 100000 }],
      });
    nock(MOYSKLAD_API)
      .post(`${MOYSKLAD_REMAP}/entity/customerorder`)
      .reply(429, { errors: [{ error: 'Слишком много запросов' }] });

    const error = await captureApiError(
      moyskladCreateOrder(
        createService(),
        { dealId: '42', items: [{ productId: 'product-1', quantity: 1 }] },
        { endpoint: moyskladMcpUrl },
      ),
    );

    expect(error.getResponse()).toMatchObject({
      statusCode: 502,
      code: ERROR_KEYS.mcpProvider,
    });
    expect((error as Error).message).toContain('HTTP 429');
  });

  it('заказ без организации и контрагента в env — 503 provider_not_configured', async () => {
    delete process.env.MOYSKLAD_DEFAULT_ORGANIZATION_ID;
    delete process.env.MOYSKLAD_DEFAULT_AGENT_ID;

    const error = await captureApiError(
      moyskladCreateOrder(
        createService(),
        { dealId: '42', items: [{ productId: 'product-1', quantity: 1 }] },
        { endpoint: moyskladMcpUrl },
      ),
    );

    expect(error.getResponse()).toMatchObject({
      statusCode: 503,
      code: ERROR_KEYS.providerNotConfigured,
    });
    expect((error as Error).message).toContain(
      'MOYSKLAD_DEFAULT_ORGANIZATION_ID',
    );
    expect((error as Error).message).toContain('MOYSKLAD_DEFAULT_AGENT_ID');
  });

  it('заказ с некорректным ID организации — 503 до вызова MCP', async () => {
    process.env.MOYSKLAD_DEFAULT_ORGANIZATION_ID = 'https://evil.example/org';

    const error = await captureApiError(
      moyskladCreateOrder(
        createService(),
        { dealId: '42', items: [{ productId: 'product-1', quantity: 1 }] },
        { endpoint: moyskladMcpUrl },
      ),
    );

    expect(error.getResponse()).toMatchObject({
      statusCode: 503,
      code: ERROR_KEYS.providerNotConfigured,
    });
  });

  it('транспорт MCP: 429 на /sse не ретраится и даёт 502', async () => {
    nock('http://moysklad-mcp.test').get('/sse').reply(429, {
      status: 'error',
      message: 'too many requests',
    });

    const error = await captureApiError(
      moyskladCheckStock(
        createService(),
        { productId: 'product-1', quantity: 1 },
        { endpoint: 'http://moysklad-mcp.test' },
      ),
    );

    expect(error.getResponse()).toMatchObject({
      statusCode: 502,
      code: ERROR_KEYS.mcpProvider,
    });
  });

  it('финальной считается стадия WON в любой воронке', () => {
    expect(isFinalDealStage('WON')).toBe(true);
    expect(isFinalDealStage('c1:won')).toBe(true);
    expect(isFinalDealStage('EXECUTING')).toBe(false);
  });
});
