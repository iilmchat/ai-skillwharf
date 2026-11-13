import { describe, expect, it, vi } from 'vitest';
import { ApiException } from '../common/api-error.js';
import { ERROR_KEYS } from '../i18n/error-keys.js';
import { AgentToolsService } from './agent-tools.service.js';

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
const getBotToken = vi.fn(async () => 'user-bot-token');

const service = new AgentToolsService(
  { runCommand } as unknown as ConstructorParameters<typeof AgentToolsService>[0],
  {
    sendMessage,
  } as unknown as ConstructorParameters<typeof AgentToolsService>[1],
  {
    appendSheetRows,
    createDocument,
    createCalendarEvent,
  } as unknown as ConstructorParameters<typeof AgentToolsService>[2],
  {
    getBotToken,
  } as unknown as ConstructorParameters<typeof AgentToolsService>[3],
);

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
});
