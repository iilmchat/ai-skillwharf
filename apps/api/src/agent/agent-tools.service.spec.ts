import { describe, expect, it, vi } from 'vitest';
import { ApiException } from '../common/api-error.js';
import { ERROR_KEYS } from '../i18n/error-keys.js';
import { AgentToolsService } from './agent-tools.service.js';
import { FinanceSnapshotStore } from './finance/finance-snapshot.store.js';
import { MarketplaceMcpService } from './tools/marketplace-mcp.service.js';

const runCommand = vi.fn(async () => 'ok');
const sendMessage = vi.fn(async () => ({ messageId: 11, chatId: '42' }));
const appendSheetRows = vi.fn(async () => ({
  spreadsheetId: 'sheet-1',
  updatedRange: 'Sheet1!A1:B2',
}));
const createDocument = vi.fn(async () => ({
  documentId: 'doc-1',
  title: 'Отчёт',
  url: 'https://docs.google.com/document/d/doc-1/edit',
}));
const createCalendarEvent = vi.fn(async () => ({
  eventId: 'event-1',
  htmlLink: 'https://calendar.google.com/event-1',
}));
const getBotToken = vi.fn(
  async (): Promise<string | null> => 'user-bot-token',
);
const unitEconomics = vi.fn(async () => ({
  tool: 'unit-economics' as const,
  marketplace: 'ozon' as const,
  sku: 'SKU-1',
  period: { from: '2026-11-01', to: '2026-11-13' },
  dataAvailable: true,
  revenueCurrency: 'RUB' as const,
  margin: 100,
  assumptions: [],
  sources: ['ozon_finance_totals'],
}));
const profitLeaks = vi.fn(async () => ({
  tool: 'profit-leak-detector',
  dataAvailable: true,
  findings: [],
}));
const priceMonitor = vi.fn(async () => ({
  tool: 'price-monitor',
  dataAvailable: true,
  ownPrice: 100,
}));
const fraudAudit = vi.fn(async () => ({
  tool: 'fraud-shield-audit',
  dataAvailable: true,
  eridPresent: false,
  findings: [],
}));
const generateImage = vi.fn(async () => ({
  taskId: 'task-1',
  imageUrl: 'https://cdn.example.com/image.png',
  status: 'completed',
}));

/** Подменяемые зависимости сервиса инструментов. */
interface ToolsOverrides {
  readonly marketplace?: unknown;
  readonly documents?: unknown;
  readonly factChecker?: unknown;
  readonly resumeScreener?: unknown;
  readonly snapshots?: unknown;
}

/** Сервис с фиктивными транспортами: бизнес-логика инструментов — в других тестах. */
function createTools(overrides: ToolsOverrides = {}): AgentToolsService {
  const args = [
    { runCommand },
    { sendMessage },
    { appendSheetRows, createDocument, createCalendarEvent },
    { getBotToken },
    overrides.marketplace ?? new MarketplaceMcpService(),
    { unitEconomics, profitLeaks, priceMonitor, fraudAudit },
    { generate: generateImage },
    overrides.documents ?? {},
    overrides.factChecker ?? {},
    overrides.resumeScreener ?? {},
    overrides.snapshots,
  ] as unknown as ConstructorParameters<typeof AgentToolsService>;

  return new AgentToolsService(...args);
}

const service = createTools();

describe('AgentToolsService', () => {
  it('отдаёт базовые инструменты в виде JSON Schema', () => {
    const descriptors = service.buildDescriptors([]);
    const sandbox = descriptors.find(
      (descriptor) => descriptor.name === 'execute_sandbox_code',
    );

    expect(descriptors.map((descriptor) => descriptor.name)).toEqual([
      'execute_sandbox_code',
      'web_search',
      'exec',
    ]);
    expect(sandbox?.parameters).toMatchObject({
      type: 'object',
      properties: { code: { type: 'string' } },
    });
    expect(sandbox?.parameters.$schema).toBeUndefined();
  });

  it('валидирует аргументы и вызывает песочницу', async () => {
    await service.execute('exec', { command: 'echo hi' });

    expect(runCommand).toHaveBeenCalledWith(
      'echo hi',
      {},
      { egress: undefined },
    );
  });

  it('не пропускает аргументы не по схеме', async () => {
    await expect(service.execute('exec', { command: 42 })).rejects.toThrow();
  });

  it('отдаёт marketplace_unavailable, если ключи маркетплейса не заданы', async () => {
    delete process.env.OZON_CLIENT_ID;
    delete process.env.OZON_API_KEY;

    const error: unknown = await service
      .execute('ozon_mcp_call', { action: 'get_products', params: {} })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiException);
    expect((error as ApiException).getResponse()).toMatchObject({
      statusCode: 503,
      code: ERROR_KEYS.marketplaceUnavailable,
    });
  });

  it('send_message отправляет через Telegram с ботом пользователя', async () => {
    const result = await service.execute(
      'send_message',
      {
        channel: 'telegram',
        to: '42',
        text: 'привет',
        buttons: [{ text: 'Сайт', url: 'https://example.com' }],
      },
      { userId: 'user-1' },
    );

    expect(getBotToken).toHaveBeenCalledWith('user-1');
    expect(sendMessage).toHaveBeenCalledWith({
      chatId: '42',
      text: 'привет',
      botToken: 'user-bot-token',
      buttons: [{ text: 'Сайт', url: 'https://example.com' }],
    });
    expect(JSON.parse(result)).toEqual({
      channel: 'telegram',
      chatId: '42',
      messageId: 11,
    });
  });

  it('send_message отклоняет ещё не подключённые каналы', async () => {
    const error: unknown = await service
      .execute('send_message', {
        channel: 'vk',
        to: '42',
        text: 'привет',
      })
      .catch((caught: unknown) => caught);

    expect((error as ApiException).getResponse()).toMatchObject({
      statusCode: 400,
      code: ERROR_KEYS.invalidRequest,
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('google_sheets_append вызывает Sheets API от имени пользователя', async () => {
    const result = await service.execute(
      'google_sheets_append',
      { sheetId: 'sheet-1', values: [['a', 1]], range: 'Sheet1!A1' },
      { userId: 'user-1' },
    );

    expect(appendSheetRows).toHaveBeenCalledWith('user-1', {
      spreadsheetId: 'sheet-1',
      values: [['a', 1]],
      range: 'Sheet1!A1',
    });
    expect(JSON.parse(result)).toEqual({
      spreadsheetId: 'sheet-1',
      updatedRange: 'Sheet1!A1:B2',
    });
  });

  it('google_docs_create возвращает documentId и ссылку', async () => {
    const result = await service.execute(
      'google_docs_create',
      { title: 'Отчёт', content: 'Текст' },
      { userId: 'user-1' },
    );

    expect(createDocument).toHaveBeenCalledWith('user-1', {
      title: 'Отчёт',
      content: 'Текст',
    });
    expect(JSON.parse(result)).toMatchObject({ documentId: 'doc-1' });
  });

  it('google_calendar_create возвращает eventId', async () => {
    const result = await service.execute(
      'google_calendar_create',
      {
        summary: 'Встреча',
        start: '2026-11-20T10:00:00Z',
        end: '2026-11-20T11:00:00Z',
      },
      { userId: 'user-1' },
    );

    expect(createCalendarEvent).toHaveBeenCalledWith('user-1', {
      summary: 'Встреча',
      start: '2026-11-20T10:00:00Z',
      end: '2026-11-20T11:00:00Z',
    });
    expect(JSON.parse(result)).toMatchObject({ eventId: 'event-1' });
  });

  it('Google-инструмент без пользователя отдаёт 400', async () => {
    const error: unknown = await service
      .execute('google_sheets_append', {
        sheetId: 'sheet-1',
        values: [['a']],
      })
      .catch((caught: unknown) => caught);

    expect((error as ApiException).getResponse()).toMatchObject({
      statusCode: 400,
      code: ERROR_KEYS.invalidRequest,
    });
  });

  it('без подключённого бота использует системный (botToken не передаётся)', async () => {
    getBotToken.mockResolvedValueOnce(null);

    await service.execute(
      'send_message',
      { channel: 'telegram', to: '42', text: 'x' },
      { userId: 'user-2' },
    );

    expect(sendMessage).toHaveBeenLastCalledWith({
      chatId: '42',
      text: 'x',
    });
  });

  it('unit-economics: реальный расчёт, списание после вызова, JSON в ответ', async () => {
    const order: string[] = [];
    const beforeExecute = vi.fn(async () => {
      order.push('charge');
    });

    unitEconomics.mockImplementationOnce(async () => {
      order.push('finance');

      return {
        tool: 'unit-economics' as const,
        marketplace: 'ozon' as const,
        sku: 'SKU-1',
        period: { from: '2026-11-01', to: '2026-11-13' },
        dataAvailable: true,
        revenueCurrency: 'RUB' as const,
        margin: 100,
        assumptions: [],
        sources: ['ozon_finance_totals'],
      };
    });

    const skills = [
      { id: 's1', name: 'unit-economics', manifest: {}, isEnabled: true },
    ];
    const result = await service.execute(
      'calculate_unit_economics',
      { sku: 'SKU-1', marketplace: 'ozon', cost: 500 },
      { beforeExecute, skills },
    );

    expect(unitEconomics).toHaveBeenLastCalledWith(
      { sku: 'SKU-1', marketplace: 'ozon', cost: 500 },
      { skills },
    );
    expect(order).toEqual(['finance', 'charge']);
    expect(JSON.parse(result)).toMatchObject({
      tool: 'unit-economics',
      margin: 100,
    });
  });

  it('unit-economics: ошибка MCP не списывает средства', async () => {
    const beforeExecute = vi.fn(async () => undefined);
    const mcpError = new ApiException({
      statusCode: 502,
      error: 'Bad Gateway',
      code: ERROR_KEYS.mcpProvider,
      message: 'MCP down',
    });

    unitEconomics.mockRejectedValueOnce(mcpError);

    await expect(
      service.execute(
        'calculate_unit_economics',
        { sku: 'SKU-1' },
        { beforeExecute },
      ),
    ).rejects.toBe(mcpError);
    expect(beforeExecute).not.toHaveBeenCalled();
  });

  it('profit/price/fraud вызывают finance-сервис и возвращают JSON', async () => {
    await service.execute('detect_profit_leaks', {
      sellerId: 'shop-1',
      marketplace: 'wb',
    });
    await service.execute('monitor_competitor_prices', {
      sku: 'SKU-1',
      productId: 123,
    });
    await service.execute('audit_fraud_risk', {
      campaignId: '555',
      marketplace: 'ozon',
    });

    expect(profitLeaks).toHaveBeenCalledWith(
      { sellerId: 'shop-1', marketplace: 'wb' },
      {},
    );
    expect(priceMonitor).toHaveBeenCalledWith(
      { sku: 'SKU-1', productId: 123 },
      {},
    );
    expect(fraudAudit).toHaveBeenCalledWith(
      { campaignId: '555', marketplace: 'ozon' },
      {},
    );
  });

  it('generate_image зовёт Midjourney и списывает Pay-per-Call после URL', async () => {
    const order: string[] = [];
    const beforeExecute = vi.fn(async () => {
      order.push('charge');
    });

    generateImage.mockImplementationOnce(async () => {
      order.push('midjourney');

      return {
        taskId: 'task-1',
        imageUrl: 'https://cdn.example.com/image.png',
        status: 'completed',
      };
    });

    const result = await service.execute(
      'generate_image',
      { prompt: 'кот в космосе' },
      { beforeExecute },
    );

    expect(generateImage).toHaveBeenLastCalledWith('кот в космосе', {});
    expect(order).toEqual(['midjourney', 'charge']);
    expect(JSON.parse(result)).toMatchObject({
      taskId: 'task-1',
      imageUrl: 'https://cdn.example.com/image.png',
    });
  });

  it('generate_image: ошибка провайдера не списывает средства', async () => {
    const beforeExecute = vi.fn(async () => undefined);
    const providerError = new ApiException({
      statusCode: 502,
      error: 'Bad Gateway',
      code: ERROR_KEYS.providerUnavailable,
      message: 'Midjourney down',
    });

    generateImage.mockRejectedValueOnce(providerError);

    await expect(
      service.execute('generate_image', { prompt: 'x' }, { beforeExecute }),
    ).rejects.toBe(providerError);
    expect(beforeExecute).not.toHaveBeenCalled();
  });
});

/** Сервис с хранилищем снапшотов: проверяем связку «tool call → дашборд». */
function serviceWithSnapshots(snapshots: unknown): AgentToolsService {
  return createTools({ snapshots });
}

describe('AgentToolsService: снапшоты финансового дашборда', () => {
  it('unit-economics сохраняется с ключом marketplace|sku', async () => {
    const store = new FinanceSnapshotStore('');

    await serviceWithSnapshots(store).execute(
      'calculate_unit_economics',
      { sku: 'SKU-1', marketplace: 'ozon' },
      { userId: 'user-1' },
    );

    const snapshots = await store.read('user-1');

    expect(snapshots.unitEconomics).toHaveLength(1);
    expect(snapshots.unitEconomics[0]?.key).toBe('ozon|SKU-1');
    expect(snapshots.unitEconomics[0]?.value).toMatchObject({
      tool: 'unit-economics',
      dataAvailable: true,
    });
  });

  it('profit-leaks и fraud-shield тоже попадают в дашборд', async () => {
    const store = new FinanceSnapshotStore('');
    const tools = serviceWithSnapshots(store);

    await tools.execute(
      'detect_profit_leaks',
      { sellerId: 'shop-1', marketplace: 'wb' },
      { userId: 'user-1' },
    );
    await tools.execute(
      'audit_fraud_risk',
      { campaignId: '555', marketplace: 'ozon' },
      { userId: 'user-1' },
    );

    const snapshots = await store.read('user-1');

    expect(snapshots.profitLeaks).toHaveLength(1);
    expect(snapshots.fraudShield).toHaveLength(1);
  });

  it('без userId снапшоты не пишутся', async () => {
    const store = new FinanceSnapshotStore('');

    await serviceWithSnapshots(store).execute('detect_profit_leaks', {
      sellerId: 'shop-1',
    });

    await expect(store.read('user-1')).resolves.toMatchObject({
      profitLeaks: [],
    });
  });

  it('ошибка хранилища не ломает ответ инструмента', async () => {
    const failing = { record: vi.fn(async () => { throw new Error('redis down'); }) };

    const result = await serviceWithSnapshots(failing).execute(
      'calculate_unit_economics',
      { sku: 'SKU-1' },
      { userId: 'user-1' },
    );

    expect(JSON.parse(result)).toMatchObject({ tool: 'unit-economics' });
    expect(failing.record).toHaveBeenCalled();
  });
});

describe('AgentToolsService: ключи провайдеров из БД', () => {
  it('generate_image передаёт userId в Midjourney (ключ пользователя)', async () => {
    await service.execute(
      'generate_image',
      { prompt: 'промпт' },
      { userId: 'user-1' },
    );

    expect(generateImage).toHaveBeenLastCalledWith('промпт', {
      userId: 'user-1',
    });
  });

  it('ozon/wb MCP передают userId в MarketplaceMcpService', async () => {
    const call = vi.fn(async () => '{"result":[]}');
    const tools = createTools({ marketplace: { call } });

    await tools.execute(
      'ozon_mcp_call',
      { action: 'ozon_cards_list', params: {} },
      { userId: 'user-1' },
    );

    expect(call).toHaveBeenCalledWith(
      'ozon',
      'ozon_cards_list',
      {},
      expect.objectContaining({ userId: 'user-1' }),
    );
  });
});

describe('AgentToolsService: документы и контент', () => {
  const extractPdf = vi.fn(async () => '{"tool":"pdf-extractor"}');
  const writeDocx = vi.fn(async () => '{"tool":"docx-writer"}');
  const ocrDocument = vi.fn(async () => '{"tool":"ocr-smart-engine"}');
  const extractDocumentData = vi.fn(async () => '{"tool":"document-analyzer"}');
  const check = vi.fn(async () => '{"tool":"fact-checker"}');
  const screen = vi.fn(() => '{"tool":"resume-screener"}');
  const tools = createTools({
    documents: { extractPdf, writeDocx, ocrDocument, extractDocumentData },
    factChecker: { check },
    resumeScreener: { screen },
  });

  it('extract_pdf/write_docx/ocr_document/extract_document_data делегируют в сервис', async () => {
    await tools.execute('extract_pdf', { path: 'contract.pdf' });
    await tools.execute('write_docx', {
      title: 'Отчёт',
      blocks: [{ type: 'paragraph', text: 'x' }],
    });
    await tools.execute('ocr_document', { path: 'scan.png' });
    await tools.execute('extract_document_data', {
      documentText: 'Договор на 100000 руб.',
    });

    expect(extractPdf).toHaveBeenCalledWith({ path: 'contract.pdf' });
    expect(writeDocx).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Отчёт' }),
    );
    expect(ocrDocument).toHaveBeenCalledWith({ path: 'scan.png' });
    expect(extractDocumentData).toHaveBeenCalledWith({
      documentText: 'Договор на 100000 руб.',
    });
  });

  it('check_facts и screen_resume делегируют в сервисы', async () => {
    await tools.execute('check_facts', { text: 'Земля круглая' });
    await tools.execute('screen_resume', { resumeText: 'Опыт 5 лет' });

    expect(check).toHaveBeenCalledWith({ text: 'Земля круглая' });
    expect(screen).toHaveBeenCalledWith({ resumeText: 'Опыт 5 лет' });
  });

  it('check_facts списывает Pay-per-Call только после успешного ответа', async () => {
    const order: string[] = [];
    const beforeExecute = vi.fn(async () => {
      order.push('charge');
    });

    check.mockImplementationOnce(async () => {
      order.push('search');

      return '{"tool":"fact-checker"}';
    });

    const result = await tools.execute(
      'check_facts',
      { text: 'Выручка выросла на 25%' },
      { beforeExecute },
    );

    expect(order).toEqual(['search', 'charge']);
    expect(JSON.parse(result)).toMatchObject({ tool: 'fact-checker' });
  });

  it('ошибка проверки фактов не списывает средства', async () => {
    const beforeExecute = vi.fn(async () => undefined);

    check.mockRejectedValueOnce(new Error('Tavily down'));

    await expect(
      tools.execute('check_facts', { text: 'x' }, { beforeExecute }),
    ).rejects.toThrow('Tavily down');
    expect(beforeExecute).not.toHaveBeenCalled();
  });

  it('экспортирует новые инструменты в дескрипторах для LLM', () => {
    const manifest = (name: string, tools: string[], permissions: string[]) => ({
      name,
      version: '1.0.0',
      description: name,
      author: { name: 'SkillWharf Team' },
      permissions,
      dependencies: { tools },
    });
    const descriptors = tools.buildDescriptors([
      {
        id: 's1',
        name: 'pdf-extractor',
        manifest: manifest('pdf-extractor', ['extract_pdf'], ['filesystem']),
        isEnabled: true,
      },
      {
        id: 's2',
        name: 'docx-writer',
        manifest: manifest('docx-writer', ['write_docx'], ['filesystem']),
        isEnabled: true,
      },
      {
        id: 's3',
        name: 'ocr-smart-engine',
        manifest: manifest('ocr-smart-engine', ['ocr_document'], [
          'filesystem',
          'network',
        ]),
        isEnabled: true,
      },
      {
        id: 's4',
        name: 'fact-checker',
        manifest: manifest('fact-checker', ['check_facts'], ['network']),
        isEnabled: true,
      },
      {
        id: 's5',
        name: 'resume-screener',
        manifest: manifest('resume-screener', ['screen_resume'], []),
        isEnabled: true,
      },
      {
        id: 's6',
        name: 'document-analyzer',
        manifest: manifest('document-analyzer', ['extract_document_data'], [
          'filesystem',
        ]),
        isEnabled: true,
      },
    ]);
    const names = descriptors.map((descriptor) => descriptor.name);

    expect(names).toEqual(
      expect.arrayContaining([
        'extract_pdf',
        'write_docx',
        'ocr_document',
        'check_facts',
        'screen_resume',
        'extract_document_data',
      ]),
    );
    // JSON Schema инструментов строится без ошибок и без $schema.
    for (const descriptor of descriptors) {
      expect(descriptor.parameters.$schema).toBeUndefined();
      expect(descriptor.parameters.type).toBe('object');
    }
  });
});
