import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import {
  connectTelegramChannel,
  connectTelegramChannelSchema,
  deleteTelegramChannel,
  fetchTelegramChannels,
  getTelegramChannelsErrorKind,
  parseAllowedChatIds,
  telegramBotTokenSchema,
  telegramChannelSchema,
} from './telegram-channels';

const { getMock, postMock, deleteMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  deleteMock: vi.fn(),
}));

vi.mock('./api', () => ({
  api: { get: getMock, post: postMock, delete: deleteMock },
}));

const CHANNEL = {
  id: 'ch-1',
  workspaceId: 'ws-1',
  botUsername: '@skillwharf_bot',
  maskedToken: '123456:****',
  webhookUrl: 'https://api.example.com/webhooks/telegram/ch-1',
  allowedChatIds: ['123456789', '-1001234567890'],
  isActive: true,
  lastMessageAt: null,
  createdAt: '2026-11-20T10:00:00.000Z',
};

const TOKEN = `123456789:${'a'.repeat(35)}`;

describe('telegramChannelSchema', () => {
  it('принимает подключённый канал', () => {
    expect(telegramChannelSchema.parse(CHANNEL)).toEqual(CHANNEL);
  });

  it('допускает отсутствующие username и lastMessageAt', () => {
    const parsed = telegramChannelSchema.parse({
      id: CHANNEL.id,
      workspaceId: CHANNEL.workspaceId,
      maskedToken: CHANNEL.maskedToken,
      webhookUrl: CHANNEL.webhookUrl,
      allowedChatIds: CHANNEL.allowedChatIds,
      isActive: CHANNEL.isActive,
      createdAt: CHANNEL.createdAt,
    });

    expect(parsed.botUsername).toBeUndefined();
    expect(parsed.lastMessageAt).toBeUndefined();
    expect(CHANNEL.lastMessageAt).toBeNull();
  });

  it('понимает поле tokenMasked из ответа API', () => {
    const parsed = telegramChannelSchema.parse({
      id: CHANNEL.id,
      workspaceId: CHANNEL.workspaceId,
      userId: 'user-1',
      botUsername: CHANNEL.botUsername,
      tokenMasked: '123456:****',
      webhookUrl: CHANNEL.webhookUrl,
      allowedChatIds: CHANNEL.allowedChatIds,
      isActive: true,
      lastMessageAt: null,
      createdAt: CHANNEL.createdAt,
    });

    expect(parsed.maskedToken).toBe('123456:****');
  });

  it('отклоняет канал без обязательных полей', () => {
    expect(
      telegramChannelSchema.safeParse({ ...CHANNEL, allowedChatIds: null })
        .success,
    ).toBe(false);
    expect(
      telegramChannelSchema.safeParse({ ...CHANNEL, isActive: 'yes' }).success,
    ).toBe(false);
  });
});

describe('валидация формы подключения', () => {
  it('проверяет формат токена @BotFather', () => {
    expect(telegramBotTokenSchema.parse(TOKEN)).toBe(TOKEN);
    expect(telegramBotTokenSchema.safeParse('123:short').success).toBe(false);
    expect(
      telegramBotTokenSchema.safeParse(`${'a'.repeat(35)}:123456789`).success,
    ).toBe(false);
  });

  it('разбирает chat_id из запятых, пробелов и переносов строк', () => {
    expect(parseAllowedChatIds('123, -100200  \n 456;789')).toEqual([
      '123',
      '-100200',
      '456',
      '789',
    ]);
    expect(parseAllowedChatIds('abc, 42')).toEqual(['42']);
  });

  it('преобразует строку формы в массив числовых chat_id', () => {
    const parsed = connectTelegramChannelSchema.parse({
      botToken: TOKEN,
      allowedChatIds: '123, 456',
    });

    expect(parsed).toEqual({ botToken: TOKEN, allowedChatIds: ['123', '456'] });
  });

  it('отклоняет пустой список и некорректный токен', () => {
    expect(
      connectTelegramChannelSchema.safeParse({
        botToken: TOKEN,
        allowedChatIds: 'abc, def',
      }).success,
    ).toBe(false);
    expect(
      connectTelegramChannelSchema.safeParse({
        botToken: 'bad',
        allowedChatIds: '123',
      }).success,
    ).toBe(false);
  });
});

describe('API-клиент Telegram-каналов', () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
    deleteMock.mockReset();
  });

  const URL = '/workspaces/ws-1/channels/telegram';

  it('читает список каналов из массива и из обёртки', async () => {
    getMock.mockResolvedValueOnce({ data: [CHANNEL] });
    await expect(fetchTelegramChannels('ws-1')).resolves.toEqual([CHANNEL]);
    expect(getMock).toHaveBeenCalledWith(URL);

    getMock.mockResolvedValueOnce({ data: { items: [CHANNEL] } });
    await expect(fetchTelegramChannels('ws-1')).resolves.toEqual([CHANNEL]);
  });

  it('отбрасывает невалидный ответ API', async () => {
    getMock.mockResolvedValueOnce({ data: [{ ...CHANNEL, id: '' }] });

    await expect(fetchTelegramChannels('ws-1')).rejects.toBeInstanceOf(
      ZodError,
    );
  });

  it('подключает канал валидированным запросом', async () => {
    postMock.mockResolvedValueOnce({ data: CHANNEL });

    await expect(
      connectTelegramChannel('ws-1', {
        botToken: TOKEN,
        allowedChatIds: '123, 456',
      }),
    ).resolves.toEqual(CHANNEL);
    expect(postMock).toHaveBeenCalledWith(URL, {
      botToken: TOKEN,
      allowedChatIds: ['123', '456'],
    });
  });

  it('не отправляет запрос с невалидным токеном', async () => {
    await expect(
      connectTelegramChannel('ws-1', {
        botToken: 'bad',
        allowedChatIds: '123',
      }),
    ).rejects.toBeInstanceOf(ZodError);
    expect(postMock).not.toHaveBeenCalled();
  });

  it('удаляет канал по id', async () => {
    deleteMock.mockResolvedValueOnce({ data: { id: 'ch-1' } });

    await expect(deleteTelegramChannel('ws-1', 'ch/1')).resolves.toBeUndefined();
    expect(deleteMock).toHaveBeenCalledWith(`${URL}/ch%2F1`);
  });

  it('распознаёт категории ошибок', () => {
    expect(getTelegramChannelsErrorKind(new ZodError([]))).toBe('invalid');
    expect(
      getTelegramChannelsErrorKind({
        isAxiosError: true,
        response: { status: 403 },
      }),
    ).toBe('forbidden');
    expect(
      getTelegramChannelsErrorKind({
        isAxiosError: true,
        response: { status: 404 },
      }),
    ).toBe('unavailable');
  });
});
