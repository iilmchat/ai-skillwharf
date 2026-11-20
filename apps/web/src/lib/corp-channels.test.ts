import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import {
  connectCorpChannel,
  connectCorpChannelSchema,
  corpChannelSchema,
  corpProviderSchema,
  deleteCorpChannel,
  fetchCorpChannels,
  getCorpChannelsErrorKind,
  parseCorpChatIds,
} from './corp-channels';

const { getMock, postMock, deleteMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  deleteMock: vi.fn(),
}));

vi.mock('./api', () => ({
  api: { get: getMock, post: postMock, delete: deleteMock },
}));

const CHANNEL = {
  id: 'corp-1',
  workspaceId: 'ws-1',
  provider: 'vk_teams',
  name: 'Мой VK Teams',
  apiBaseUrl: 'https://messenger.example.com',
  tokenMasked: 'abcd****',
  webhookUrl: 'https://api.example.com/webhooks/corp/corp-1',
  allowedChatIds: ['12345', '-100500'],
  isActive: true,
  lastMessageAt: null,
  createdAt: '2026-11-20T10:00:00.000Z',
};

const FORM = {
  provider: 'pachca',
  name: 'ПачкаSupport',
  botToken: 'pachca-secret-token',
  allowedChatIds: '111, 222',
} as const;

describe('corpProviderSchema', () => {
  it('принимает все три провайдера', () => {
    expect(corpProviderSchema.parse('vk_teams')).toBe('vk_teams');
    expect(corpProviderSchema.parse('pachca')).toBe('pachca');
    expect(corpProviderSchema.parse('yandex_messenger')).toBe(
      'yandex_messenger',
    );
  });

  it('отклоняет неизвестного провайдера', () => {
    expect(corpProviderSchema.safeParse('telegram').success).toBe(false);
  });
});

describe('corpChannelSchema', () => {
  it('принимает канал с настройками on-premise', () => {
    expect(corpChannelSchema.parse(CHANNEL)).toMatchObject({
      provider: 'vk_teams',
      apiBaseUrl: 'https://messenger.example.com',
      tokenMasked: 'abcd****',
    });
  });

  it('поддерживает поле maskedToken и секрет созданного канала', () => {
    const parsed = corpChannelSchema.parse({
      ...CHANNEL,
      apiBaseUrl: null,
      tokenMasked: undefined,
      maskedToken: 'fallback****',
      webhookSecret: 'one-time-secret',
    });

    expect(parsed.tokenMasked).toBe('fallback****');
    expect(parsed.apiBaseUrl).toBeUndefined();
    expect(parsed.webhookSecret).toBe('one-time-secret');
  });

  it('отклоняет канал без обязательных полей', () => {
    expect(
      corpChannelSchema.safeParse({ ...CHANNEL, provider: 'telegram' }).success,
    ).toBe(false);
    expect(
      corpChannelSchema.safeParse({ ...CHANNEL, allowedChatIds: null }).success,
    ).toBe(false);
  });
});

describe('валидация формы подключения', () => {
  it('разбирает Chat ID из запятых, пробелов и переносов', () => {
    expect(parseCorpChatIds('123, abc_def; -100500\nuser@chat')).toEqual([
      '123',
      'abc_def',
      '-100500',
      'user@chat',
    ]);
  });

  it('преобразует форму в запрос API', () => {
    expect(connectCorpChannelSchema.parse(FORM)).toEqual({
      provider: 'pachca',
      name: 'ПачкаSupport',
      botToken: 'pachca-secret-token',
      allowedChatIds: ['111', '222'],
    });
  });

  it('принимает http(s) Base URL и отбрасывает пустой', () => {
    const parsed = connectCorpChannelSchema.parse({
      ...FORM,
      apiBaseUrl: 'http://10.0.0.5:8080',
    });

    expect(parsed.apiBaseUrl).toBe('http://10.0.0.5:8080');
    expect(
      connectCorpChannelSchema.parse({ ...FORM, apiBaseUrl: '' }).apiBaseUrl,
    ).toBeUndefined();
    expect(
      connectCorpChannelSchema.safeParse({
        ...FORM,
        apiBaseUrl: 'ftp://server',
      }).success,
    ).toBe(false);
  });

  it('проверяет имя, токен и список Chat ID', () => {
    expect(
      connectCorpChannelSchema.safeParse({ ...FORM, name: 'x' }).success,
    ).toBe(false);
    expect(
      connectCorpChannelSchema.safeParse({ ...FORM, botToken: '' }).success,
    ).toBe(false);
    expect(
      connectCorpChannelSchema.safeParse({ ...FORM, allowedChatIds: '!!!' })
        .success,
    ).toBe(false);
    expect(
      connectCorpChannelSchema.safeParse({ ...FORM, name: 'x'.repeat(81) })
        .success,
    ).toBe(false);
  });
});

describe('API-клиент корпоративных каналов', () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
    deleteMock.mockReset();
  });

  const URL = '/workspaces/ws-1/channels/corporate';

  it('читает каналы', async () => {
    getMock.mockResolvedValueOnce({ data: [CHANNEL] });

    await expect(fetchCorpChannels('ws-1')).resolves.toHaveLength(1);
    expect(getMock).toHaveBeenCalledWith(URL);
  });

  it('отбрасывает невалидный ответ API', async () => {
    getMock.mockResolvedValueOnce({ data: [{ ...CHANNEL, id: '' }] });

    await expect(fetchCorpChannels('ws-1')).rejects.toBeInstanceOf(ZodError);
  });

  it('подключает канал валидированным запросом', async () => {
    postMock.mockResolvedValueOnce({
      data: { ...CHANNEL, webhookSecret: 'one-time-secret' },
    });

    const result = await connectCorpChannel('ws-1', {
      ...FORM,
      apiBaseUrl: '',
    });

    expect(result.webhookSecret).toBe('one-time-secret');
    expect(postMock).toHaveBeenCalledWith(URL, {
      provider: 'pachca',
      name: 'ПачкаSupport',
      botToken: 'pachca-secret-token',
      allowedChatIds: ['111', '222'],
    });
  });

  it('не отправляет запрос с невалидной формой', async () => {
    await expect(
      connectCorpChannel('ws-1', { ...FORM, name: '' }),
    ).rejects.toBeInstanceOf(ZodError);
    expect(postMock).not.toHaveBeenCalled();
  });

  it('удаляет канал', async () => {
    deleteMock.mockResolvedValueOnce({ data: { id: 'corp-1' } });

    await expect(deleteCorpChannel('ws-1', 'corp/1')).resolves.toBeUndefined();
    expect(deleteMock).toHaveBeenCalledWith(`${URL}/corp%2F1`);
  });

  it('определяет категорию ошибки', () => {
    expect(getCorpChannelsErrorKind(new ZodError([]))).toBe('invalid');
    expect(
      getCorpChannelsErrorKind({
        isAxiosError: true,
        response: { status: 403 },
      }),
    ).toBe('forbidden');
    expect(
      getCorpChannelsErrorKind({
        isAxiosError: true,
        response: { status: 501 },
      }),
    ).toBe('unavailable');
  });
});
