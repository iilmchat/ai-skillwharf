import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import {
  callBitrixTool,
  resolveBitrixWebhookFromHeaders,
} from './server.mjs';

describe('bitrix24-mcp per-request credentials', () => {
  it('использует env-fallback, если заголовок не задан', () => {
    assert.equal(
      resolveBitrixWebhookFromHeaders({}, 'https://portal.bitrix24.ru/rest/1/env/'),
      'https://portal.bitrix24.ru/rest/1/env/',
    );
    assert.equal(resolveBitrixWebhookFromHeaders({}, null), null);
  });

  it('валидирует X-Bitrix24-Webhook-Url и не раскрывает секрет в ошибке', () => {
    const valid = resolveBitrixWebhookFromHeaders({
      'x-bitrix24-webhook-url': 'https://portal.bitrix24.ru/rest/1/request-token',
    });
    assert.equal(valid, 'https://portal.bitrix24.ru/rest/1/request-token/');

    const local = resolveBitrixWebhookFromHeaders({
      'x-bitrix24-webhook-url': 'http://127.0.0.1:9000/rest/1/test/',
    });
    assert.equal(local, 'http://127.0.0.1:9000/rest/1/test/');

    for (const bad of [
      'https://evil.example/rest/1/secret-token/',
      'http://portal.bitrix24.ru/rest/1/secret-token/',
      'https://portal.bitrix24.ru/profile.json',
    ]) {
      assert.throws(
        () =>
          resolveBitrixWebhookFromHeaders({
            'x-bitrix24-webhook-url': bad,
          }),
        (error) => {
          assert.ok(error instanceof Error);
          assert.ok(!error.message.includes('secret-token'));
          return true;
        },
      );
    }
  });

  it('вызывает API с webhook из заголовка, а не из env', async () => {
    let calledPath = '';
    const upstream = createServer((request, response) => {
      calledPath = request.url ?? '';
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ result: [{ ID: '1' }], total: 1 }));
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const address = upstream.address();
    assert.ok(address && typeof address !== 'string');

    const webhookUrl = `http://127.0.0.1:${address.port}/rest/1/request-token/`;
    const result = await callBitrixTool('crm_deal_list', { start: 0 }, { webhookUrl });

    assert.equal(calledPath, '/rest/1/request-token/crm.deal.list.json');
    assert.deepEqual(result, { result: [{ ID: '1' }], total: 1 });

    await new Promise((resolve) => upstream.close(resolve));
  });
});
