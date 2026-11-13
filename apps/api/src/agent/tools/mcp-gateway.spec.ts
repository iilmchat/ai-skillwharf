import { Logger } from '@nestjs/common';
import type { MockInstance } from 'vitest';
import { ApiException } from '../../common/api-error.js';
import {
  McpProviderError,
  McpTimeoutError,
  McpTransportError,
} from './mcp-client.js';
import {
  MCP_DEFAULT_TIMEOUT_MS,
  MCP_MAX_RETRIES,
  McpGateway,
  mcpUnavailableError,
  validateMcpCall,
  type McpGatewayOptions,
  type McpProvider,
  type McpToolDescriptor,
} from './mcp-gateway.js';

type CallTool = (
  name: string,
  args: Record<string, unknown>,
) => Promise<string>;

type ListTools = () => Promise<readonly McpToolDescriptor[]>;

type ErrorBody = {
  statusCode: number;
  error: string;
  code: string;
  message: string;
};

/** Валидный вызов известного действия Ozon. */
const OZON_VALID_CALL = {
  action: 'ozon_get_prices',
  params: { shop_id: '123', sku: ['sku-1'], limit: 10 },
};

function createGateway(
  provider: McpProvider,
  callTool: CallTool,
  overrides: Partial<
    Pick<McpGatewayOptions, 'timeoutMs' | 'maxRetries' | 'listTools'>
  > = {},
): McpGateway {
  return new McpGateway({ provider, client: { callTool }, ...overrides });
}

/** Достаёт тело единой ошибки API; проверяет, что брошен ApiException. */
async function expectApiError(promise: Promise<unknown>): Promise<ErrorBody> {
  let error: unknown;

  try {
    await promise;
  } catch (reason: unknown) {
    error = reason;
  }

  expect(error).toBeInstanceOf(ApiException);

  return (error as ApiException).getResponse();
}

/** Разбирает JSON-сообщения, которые gateway писал в Logger.warn. */
function loggedEvents(spy: MockInstance): Array<Record<string, unknown>> {
  return spy.mock.calls.map((call) => {
    const payload: unknown = call[0];

    return JSON.parse(String(payload)) as Record<string, unknown>;
  });
}

describe('McpGateway', () => {
  let loggerWarn: MockInstance;

  beforeEach(() => {
    // Gateway логирует недоступность discovery; в тестах сообщения не нужны.
    loggerWarn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('валидация до вызова клиента', () => {
    const invalidActions = [
      'OZON_GET_PRICES',
      'ozon..get',
      '',
      'a'.repeat(65),
      'ozongetprices',
      'ozon_get_prices_',
    ];

    for (const action of invalidActions) {
      it(`отклоняет невалидный action «${action}»`, async () => {
        const callTool = vi.fn<CallTool>();
        const gateway = createGateway('ozon', callTool);

        const body = await expectApiError(gateway.call({ action, params: {} }));

        expect(body).toEqual({
          statusCode: 400,
          error: 'Bad Request',
          code: 'errors.invalid_request',
          message: expect.any(String),
        });
        expect(callTool).not.toHaveBeenCalled();
      });
    }

    const fiftyOneKeys = Object.fromEntries(
      Array.from({ length: 51 }, (_value, index) => [`k${index}`, 'v']),
    );

    const invalidParams: Array<{ name: string; input: unknown }> = [
      {
        name: 'вложенный объект',
        input: {
          action: 'ozon_get_prices',
          params: { shop_id: { nested: 'x' } },
        },
      },
      {
        name: 'массив объектов',
        input: {
          action: 'ozon_get_prices',
          params: { sku: [{ id: '1' }] },
        },
      },
      {
        name: 'лишний ключ у известного действия',
        input: {
          action: 'ozon_get_prices',
          params: { unexpected: 'x' },
        },
      },
      {
        name: 'строка длиннее 4096',
        input: {
          action: 'ozon_get_prices',
          params: { shop_id: 'a'.repeat(4097) },
        },
      },
      {
        name: 'больше 50 ключей',
        input: { action: 'ozon_custom_action', params: fiftyOneKeys },
      },
      {
        name: 'ключ не в snake_case',
        input: { action: 'ozon_get_prices', params: { SHOP_ID: 'x' } },
      },
      {
        name: 'params не объект',
        input: { action: 'ozon_get_prices', params: [] },
      },
    ];

    for (const { name, input } of invalidParams) {
      it(`отклоняет params: ${name}`, async () => {
        const callTool = vi.fn<CallTool>();
        const gateway = createGateway('ozon', callTool);

        const body = await expectApiError(gateway.call(input));

        expect(body.statusCode).toBe(400);
        expect(body.code).toBe('errors.invalid_request');
        expect(callTool).not.toHaveBeenCalled();
      });
    }

    it('отклоняет period-объект у известного действия WB', async () => {
      const callTool = vi.fn<CallTool>();
      const gateway = createGateway('wb', callTool);

      const body = await expectApiError(
        gateway.call({
          action: 'wb_finance_report',
          params: { period: { from: '2026-01-01' } },
        }),
      );

      expect(body.statusCode).toBe(400);
      expect(callTool).not.toHaveBeenCalled();
    });

    it('применяет строгую схему известного действия (limit вне 1..1000)', async () => {
      const callTool = vi.fn<CallTool>();
      const gateway = createGateway('ozon', callTool);

      for (const limit of [0, -1, 1001]) {
        const body = await expectApiError(
          gateway.call({ action: 'ozon_get_prices', params: { limit } }),
        );

        expect(body.statusCode).toBe(400);
      }

      expect(callTool).not.toHaveBeenCalled();
    });

    it('пропускает неизвестное действие после структурной проверки (residual risk)', async () => {
      const callTool = vi.fn<CallTool>().mockResolvedValue('ok');
      const gateway = createGateway('ozon', callTool);

      await expect(
        gateway.call({
          action: 'ozon_custom_report',
          params: { shop_id: '1' },
        }),
      ).resolves.toBe('ok');

      expect(callTool).toHaveBeenCalledTimes(1);
    });

    it('не блокирует действие другого провайдера: известен только ozon-реестр', async () => {
      const callTool = vi.fn<CallTool>().mockResolvedValue('ok');
      const gateway = createGateway('ozon', callTool);

      await expect(
        gateway.call({ action: 'wb_cards_list', params: { shop_id: '1' } }),
      ).resolves.toBe('ok');

      expect(callTool).toHaveBeenCalledTimes(1);
    });
  });

  describe('успешный вызов', () => {
    it('вызывает клиент ровно один раз с action и params', async () => {
      const callTool = vi.fn<CallTool>().mockResolvedValue('{"price":100}');
      const gateway = createGateway('ozon', callTool);

      const result = await gateway.call(OZON_VALID_CALL);

      expect(result).toBe('{"price":100}');
      expect(callTool).toHaveBeenCalledTimes(1);
      expect(callTool).toHaveBeenCalledWith(
        'ozon_get_prices',
        OZON_VALID_CALL.params,
      );
    });
  });

  describe('маппинг ошибок и retry', () => {
    it('provider error не повторяет вызов и отдаёт 502', async () => {
      const callTool = vi.fn<CallTool>().mockRejectedValue(
        new McpProviderError('MCP tools/call: invalid params', {
          rpcCode: -32602,
        }),
      );
      const gateway = createGateway('ozon', callTool);

      const body = await expectApiError(gateway.call(OZON_VALID_CALL));

      expect(body).toEqual({
        statusCode: 502,
        error: 'Bad Gateway',
        code: 'errors.mcp_provider',
        message: expect.any(String),
      });
      expect(callTool).toHaveBeenCalledTimes(1);
    });

    it('не утекает текст provider-ошибки с токеном в тело API', async () => {
      const callTool = vi.fn<CallTool>().mockRejectedValue(
        new McpProviderError('invalid params: Bearer super-secret-token', {
          rpcCode: -32602,
        }),
      );
      const gateway = createGateway('ozon', callTool);

      const body = await expectApiError(gateway.call(OZON_VALID_CALL));

      expect(body.message).not.toContain('super-secret-token');
    });

    it('transient transport error повторяет вызов один раз и отдаёт 502', async () => {
      const callTool = vi
        .fn<CallTool>()
        .mockRejectedValue(new McpTransportError('MCP SSE: ошибка сети'));
      const gateway = createGateway('ozon', callTool);

      const body = await expectApiError(gateway.call(OZON_VALID_CALL));

      expect(body.statusCode).toBe(502);
      expect(body.code).toBe('errors.mcp_provider');
      expect(callTool).toHaveBeenCalledTimes(1 + MCP_MAX_RETRIES);
    });

    it('повтор после transient error может завершиться успехом', async () => {
      const callTool = vi
        .fn<CallTool>()
        .mockRejectedValueOnce(new McpTransportError('MCP SSE: ошибка сети'))
        .mockResolvedValueOnce('ok');
      const gateway = createGateway('ozon', callTool);

      await expect(gateway.call(OZON_VALID_CALL)).resolves.toBe('ok');
      expect(callTool).toHaveBeenCalledTimes(2);
    });

    it('HTTP 4xx transport error не повторяется (не transient)', async () => {
      const callTool = vi
        .fn<CallTool>()
        .mockRejectedValue(
          new McpTransportError('MCP POST: HTTP 401', { statusCode: 401 }),
        );
      const gateway = createGateway('ozon', callTool);

      const body = await expectApiError(gateway.call(OZON_VALID_CALL));

      expect(body.statusCode).toBe(502);
      expect(callTool).toHaveBeenCalledTimes(1);
    });

    it('timeout отдаёт 504 и не повторяется даже при maxRetries=1', async () => {
      // Таймаут осознанно не входит в retry: одна попытка уже стоит
      // timeoutMs, повтор лишь удвоил бы ожидание пользователя.
      const callTool = vi
        .fn<CallTool>()
        .mockImplementation(() => new Promise<string>(() => undefined));
      const gateway = createGateway('ozon', callTool, {
        timeoutMs: 10,
        maxRetries: 1,
      });

      const body = await expectApiError(gateway.call(OZON_VALID_CALL));

      expect(body).toEqual({
        statusCode: 504,
        error: 'Gateway Timeout',
        code: 'errors.mcp_timeout',
        message: expect.any(String),
      });
      expect(callTool).toHaveBeenCalledTimes(1);
    });

    it('ошибка McpTimeoutError от клиента отдаёт 504 без retry', async () => {
      const callTool = vi.fn<CallTool>().mockRejectedValue(
        new McpTimeoutError('MCP: таймаут вызова tools/call', {
          timeoutMs: 15_000,
        }),
      );
      const gateway = createGateway('ozon', callTool);

      const body = await expectApiError(gateway.call(OZON_VALID_CALL));

      expect(body.statusCode).toBe(504);
      expect(body.code).toBe('errors.mcp_timeout');
      expect(callTool).toHaveBeenCalledTimes(1);
    });
  });

  describe('динамический discovery tools/list', () => {
    const DISCOVERED_TOOLS: readonly McpToolDescriptor[] = [
      { name: 'ozon_get_prices' },
      { name: 'ozon_orders_fbs' },
    ];

    it('вызывает listTools один раз на несколько call (кеш)', async () => {
      const callTool = vi.fn<CallTool>().mockResolvedValue('ok');
      const listTools = vi.fn<ListTools>().mockResolvedValue(DISCOVERED_TOOLS);
      const gateway = createGateway('ozon', callTool, { listTools });

      await gateway.call(OZON_VALID_CALL);
      await gateway.call({
        action: 'ozon_orders_fbs',
        params: { shop_id: '123' },
      });

      expect(listTools).toHaveBeenCalledTimes(1);
      expect(callTool).toHaveBeenCalledTimes(2);
      expect(loggerWarn).not.toHaveBeenCalled();
    });

    it('параллельные вызовы используют одно discovery', async () => {
      const callTool = vi.fn<CallTool>().mockResolvedValue('ok');
      const listTools = vi.fn<ListTools>().mockResolvedValue(DISCOVERED_TOOLS);
      const gateway = createGateway('ozon', callTool, { listTools });

      await Promise.all([
        gateway.call(OZON_VALID_CALL),
        gateway.call({ action: 'ozon_orders_fbs', params: {} }),
      ]);

      expect(listTools).toHaveBeenCalledTimes(1);
      expect(callTool).toHaveBeenCalledTimes(2);
    });

    it('отклоняет действие, которого нет в tools/list, до callTool', async () => {
      const callTool = vi.fn<CallTool>().mockResolvedValue('ok');
      const listTools = vi
        .fn<ListTools>()
        .mockResolvedValue([{ name: 'ozon_get_prices' }]);
      const gateway = createGateway('ozon', callTool, { listTools });

      const body = await expectApiError(
        gateway.call({ action: 'ozon_orders_fbs', params: {} }),
      );

      expect(body).toEqual({
        statusCode: 400,
        error: 'Bad Request',
        code: 'errors.invalid_request',
        message: expect.any(String),
      });
      expect(callTool).not.toHaveBeenCalled();
      expect(listTools).toHaveBeenCalledTimes(1);
    });

    it('пропускает действие из tools/list и сохраняет strict-схему', async () => {
      const callTool = vi.fn<CallTool>().mockResolvedValue('ok');
      const listTools = vi.fn<ListTools>().mockResolvedValue(DISCOVERED_TOOLS);
      const gateway = createGateway('ozon', callTool, { listTools });

      await expect(gateway.call(OZON_VALID_CALL)).resolves.toBe('ok');
      expect(callTool).toHaveBeenCalledTimes(1);
    });

    it('валидирует params известного действия из tools/list строгой схемой', async () => {
      const callTool = vi.fn<CallTool>().mockResolvedValue('ok');
      const listTools = vi.fn<ListTools>().mockResolvedValue(DISCOVERED_TOOLS);
      const gateway = createGateway('ozon', callTool, { listTools });

      const body = await expectApiError(
        gateway.call({ action: 'ozon_get_prices', params: { limit: 0 } }),
      );

      expect(body.statusCode).toBe(400);
      expect(callTool).not.toHaveBeenCalled();
    });

    it('discovery reject → structural-only вызов, лог mcp.tools_list_unavailable', async () => {
      const callTool = vi.fn<CallTool>().mockResolvedValue('ok');
      const listTools = vi
        .fn<ListTools>()
        .mockRejectedValue(new McpTransportError('MCP SSE: ошибка сети'));
      const gateway = createGateway('ozon', callTool, { listTools });

      await expect(
        gateway.call({
          action: 'ozon_custom_report',
          params: { shop_id: '123' },
        }),
      ).resolves.toBe('ok');

      expect(callTool).toHaveBeenCalledTimes(1);

      const events = loggedEvents(loggerWarn);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        event: 'mcp.tools_list_unavailable',
        provider: 'ozon',
      });
      expect(String(events[0]?.message)).toContain('MCP SSE: ошибка сети');
    });

    it('сбой discovery тоже кешируется: повторного listTools нет', async () => {
      const callTool = vi.fn<CallTool>().mockResolvedValue('ok');
      const listTools = vi
        .fn<ListTools>()
        .mockRejectedValue(new McpTransportError('MCP SSE: ошибка сети'));
      const gateway = createGateway('ozon', callTool, { listTools });

      await gateway.call({
        action: 'ozon_custom_report',
        params: { shop_id: '1' },
      });
      await gateway.call({
        action: 'ozon_custom_report',
        params: { shop_id: '2' },
      });

      expect(listTools).toHaveBeenCalledTimes(1);
      expect(callTool).toHaveBeenCalledTimes(2);
      expect(loggedEvents(loggerWarn)).toHaveLength(1);
    });

    it('маскирует токен в сообщении discovery-ошибки', async () => {
      const callTool = vi.fn<CallTool>().mockResolvedValue('ok');
      const listTools = vi
        .fn<ListTools>()
        .mockRejectedValue(
          new McpTransportError('Auth: Bearer super-secret-token'),
        );
      const gateway = createGateway('ozon', callTool, { listTools });

      await gateway.call({ action: 'ozon_custom_report', params: {} });

      const events = loggedEvents(loggerWarn);
      expect(String(events[0]?.message)).not.toContain('super-secret-token');
      expect(String(events[0]?.message)).toContain('[REDACTED]');
    });

    it('listTools отсутствует → structural-only, ровно один лог', async () => {
      const callTool = vi.fn<CallTool>().mockResolvedValue('ok');
      const gateway = createGateway('ozon', callTool);

      await gateway.call({
        action: 'ozon_custom_report',
        params: { shop_id: '1' },
      });
      await gateway.call({
        action: 'ozon_custom_report',
        params: { shop_id: '2' },
      });

      expect(callTool).toHaveBeenCalledTimes(2);
      expect(loggedEvents(loggerWarn)).toHaveLength(1);
    });

    it('пустой tools/list отклоняет любое действие', async () => {
      const callTool = vi.fn<CallTool>().mockResolvedValue('ok');
      const listTools = vi.fn<ListTools>().mockResolvedValue([]);
      const gateway = createGateway('ozon', callTool, { listTools });

      const body = await expectApiError(gateway.call(OZON_VALID_CALL));

      expect(body.statusCode).toBe(400);
      expect(callTool).not.toHaveBeenCalled();
    });
  });

  describe('экспорты для интеграции', () => {
    it('mcpUnavailableError возвращает 503 в едином формате', () => {
      expect(mcpUnavailableError().getResponse()).toEqual({
        statusCode: 503,
        error: 'Service Unavailable',
        code: 'errors.mcp_unavailable',
        message: expect.any(String),
      });
    });

    it('validateMcpCall возвращает action и params для валидного входа', () => {
      expect(validateMcpCall(OZON_VALID_CALL)).toEqual(OZON_VALID_CALL);
    });

    it('validateMcpCall бросает ApiException 400 для невалидного входа', async () => {
      await expectApiError(
        Promise.resolve().then(() => validateMcpCall({ action: 'BAD' })),
      );
    });

    it('константы таймаута и retry зафиксированы', () => {
      expect(MCP_DEFAULT_TIMEOUT_MS).toBe(15_000);
      expect(MCP_MAX_RETRIES).toBe(1);
    });
  });
});

describe('финансовые MCP-действия (Sprint 19)', () => {
  it('принимает ozon_finance_totals и передаёт параметры', async () => {
    const callTool = vi.fn<CallTool>().mockResolvedValue('{"total":1}');
    const gateway = createGateway('ozon', callTool);

    await expect(
      gateway.call({
        action: 'ozon_finance_totals',
        params: {
          date_from: '2026-11-01T00:00:00Z',
          date_to: '2026-11-13T23:59:59Z',
        },
      }),
    ).resolves.toBe('{"total":1}');
    expect(callTool).toHaveBeenCalledWith('ozon_finance_totals', {
      date_from: '2026-11-01T00:00:00Z',
      date_to: '2026-11-13T23:59:59Z',
    });
  });

  it('требует обе даты у ozon_finance_totals', async () => {
    const callTool = vi.fn<CallTool>();
    const gateway = createGateway('ozon', callTool);
    const body = await expectApiError(
      gateway.call({
        action: 'ozon_finance_totals',
        params: { date_from: '2026-11-01T00:00:00Z' },
      }),
    );

    expect(body).toMatchObject({ statusCode: 400 });
    expect(callTool).not.toHaveBeenCalled();
  });

  it('принимает wb_deductions и wb_prices_list с nmId', async () => {
    const callTool = vi.fn<CallTool>().mockResolvedValue('{}');
    const gateway = createGateway('wb', callTool);

    await gateway.call({
      action: 'wb_deductions',
      params: {
        date_from: '2026-11-01',
        date_to: '2026-11-13',
        limit: 50,
      },
    });
    await gateway.call({
      action: 'wb_prices_list',
      params: { filter_nm_id: 111 },
    });

    expect(callTool).toHaveBeenNthCalledWith(1, 'wb_deductions', {
      date_from: '2026-11-01',
      date_to: '2026-11-13',
      limit: 50,
    });
    expect(callTool).toHaveBeenNthCalledWith(2, 'wb_prices_list', {
      filter_nm_id: 111,
    });
  });

  it('отклоняет лишние поля финансовых действий', async () => {
    const callTool = vi.fn<CallTool>();
    const gateway = createGateway('wb', callTool);
    const body = await expectApiError(
      gateway.call({
        action: 'wb_prices_list',
        params: { filter_nm_id: 111, period: { from: '2026-11-01' } },
      }),
    );

    expect(body).toMatchObject({ statusCode: 400 });
    expect(callTool).not.toHaveBeenCalled();
  });

  it('принимает ozon_analytics с metrics/dimensions', async () => {
    const callTool = vi.fn<CallTool>().mockResolvedValue('{}');
    const gateway = createGateway('ozon', callTool);

    await gateway.call({
      action: 'ozon_analytics',
      params: {
        date_from: '2026-11-01',
        date_to: '2026-11-13',
        metrics: ['revenue', 'ordered_units', 'returns'],
        dimensions: ['sku'],
        limit: 1000,
      },
    });

    expect(callTool).toHaveBeenCalledWith('ozon_analytics', {
      date_from: '2026-11-01',
      date_to: '2026-11-13',
      metrics: ['revenue', 'ordered_units', 'returns'],
      dimensions: ['sku'],
      limit: 1000,
    });
  });
});
