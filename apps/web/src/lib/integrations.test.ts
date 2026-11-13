import { AxiosError, type AxiosResponse } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import {
  connectTelegram,
  fetchGoogleAuthorizationUrl,
  fetchIntegrations,
  getActiveIntegrationChannels,
  getIntegrationErrorDetails,
  getTelegramDisplayName,
  googleAuthorizationUrlSchema,
  integrationsSchema,
  telegramBotTokenSchema,
  type IntegrationsState,
} from './integrations';

const { getMock, postMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
}));

vi.mock('./api', () => ({
  api: {
    get: getMock,
    post: postMock,
    delete: vi.fn(),
  },
}));

function axiosErrorWith(data: unknown, status: number): AxiosError {
  const response = {
    data,
    status,
    statusText: 'Error',
    headers: {},
    config: {},
  } as unknown as AxiosResponse;

  return new AxiosError(
    'Request failed',
    undefined,
    undefined,
    undefined,
    response,
  );
}

const ACTIVE_STATE: IntegrationsState = {
  telegram: {
    status: 'active',
    botName: 'Wharf Bot',
    botUsername: 'wharf_bot',
  },
  google: { status: 'active', email: 'owner@example.com' },
};

describe('integrationsSchema', () => {
  it('принимает active/disconnected/error и необязательные поля', () => {
    expect(integrationsSchema.parse(ACTIVE_STATE)).toEqual(ACTIVE_STATE);
    expect(
      integrationsSchema.parse({
        telegram: { status: 'disconnected' },
        google: { status: 'error', error: 'errors.google_oauth_unavailable' },
      }),
    ).toEqual({
      telegram: { status: 'disconnected' },
      google: { status: 'error', error: 'errors.google_oauth_unavailable' },
    });
  });

  it('отклоняет неизвестный статус и отсутствующий провайдер', () => {
    expect(
      integrationsSchema.safeParse({
        telegram: { status: 'connected' },
        google: { status: 'disconnected' },
      }).success,
    ).toBe(false);
    expect(
      integrationsSchema.safeParse({
        telegram: { status: 'active' },
      }).success,
    ).toBe(false);
  });
});

describe('telegramBotTokenSchema', () => {
  it('принимает токен BotFather', () => {
    expect(
      telegramBotTokenSchema.parse('123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'),
    ).toBe('123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw');
  });

  it('отклоняет строку без bot_id и секрета', () => {
    expect(telegramBotTokenSchema.safeParse('not-a-token').success).toBe(false);
    expect(telegramBotTokenSchema.safeParse('12345:').success).toBe(false);
  });
});

describe('googleAuthorizationUrlSchema', () => {
  it('принимает только абсолютный https URL', () => {
    expect(
      googleAuthorizationUrlSchema.parse(
        'https://accounts.google.com/o/oauth2/v2/auth?client_id=x',
      ),
    ).toContain('accounts.google.com');
    expect(
      googleAuthorizationUrlSchema.safeParse(
        'http://accounts.google.com/o/oauth2/v2/auth',
      ).success,
    ).toBe(false);
    expect(
      googleAuthorizationUrlSchema.safeParse('javascript:alert(1)').success,
    ).toBe(false);
  });
});

describe('integration API', () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
  });

  it('валидирует состояние из GET /integrations', async () => {
    getMock.mockResolvedValueOnce({ data: ACTIVE_STATE });

    await expect(fetchIntegrations()).resolves.toEqual(ACTIVE_STATE);
  });

  it('принимает OAuth URL в полях url и authorizationUrl', async () => {
    getMock.mockResolvedValueOnce({
      data: { url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' },
    });
    await expect(fetchGoogleAuthorizationUrl()).resolves.toBe(
      'https://accounts.google.com/o/oauth2/v2/auth?x=1',
    );

    getMock.mockResolvedValueOnce({
      data: { authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=2' },
    });
    await expect(fetchGoogleAuthorizationUrl()).resolves.toBe(
      'https://accounts.google.com/o/oauth2/v2/auth?x=2',
    );
  });

  it('отклоняет не-https OAuth URL', async () => {
    getMock.mockResolvedValueOnce({
      data: { url: 'http://accounts.google.com/o/oauth2/v2/auth' },
    });

    await expect(fetchGoogleAuthorizationUrl()).rejects.toBeInstanceOf(
      ZodError,
    );
  });

  it('отправляет токен в POST /integrations/telegram', async () => {
    await connectTelegram('123456789:secret');

    expect(postMock).toHaveBeenCalledWith('/integrations/telegram', {
      botToken: '123456789:secret',
    });
  });
});

describe('getActiveIntegrationChannels', () => {
  it('возвращает только активные каналы в порядке telegram → google', () => {
    expect(getActiveIntegrationChannels(ACTIVE_STATE)).toEqual([
      'telegram',
      'google',
    ]);
    expect(
      getActiveIntegrationChannels({
        telegram: { status: 'active' },
        google: { status: 'disconnected' },
      }),
    ).toEqual(['telegram']);
    expect(getActiveIntegrationChannels(undefined)).toEqual([]);
  });
});

describe('getTelegramDisplayName', () => {
  it('предпочитает имя и добавляет @ к username', () => {
    expect(
      getTelegramDisplayName({
        status: 'active',
        botName: 'Wharf Bot',
        botUsername: 'wharf_bot',
      }),
    ).toBe('Wharf Bot');
    expect(
      getTelegramDisplayName({
        status: 'active',
        botUsername: 'wharf_bot',
      }),
    ).toBe('@wharf_bot');
    expect(getTelegramDisplayName({ status: 'active' })).toBeNull();
  });
});

describe('getIntegrationErrorDetails', () => {
  it('различает неверный Telegram-токен и Google OAuth по операции', () => {
    const error = axiosErrorWith(
      { code: 'errors.invalid_telegram_token', message: 'Bad token' },
      400,
    );

    expect(getIntegrationErrorDetails(error, 'telegramConnect')).toEqual({
      kind: 'invalidToken',
      serverMessage: 'errors.invalid_telegram_token',
    });
    expect(getIntegrationErrorDetails(error, 'googleConnect')).toEqual({
      kind: 'oauthUnavailable',
      serverMessage: 'errors.invalid_telegram_token',
    });
  });

  it('маппит provider_auth_required и provider_not_configured по операции', () => {
    expect(
      getIntegrationErrorDetails(
        axiosErrorWith(
          { code: 'errors.provider_auth_required', message: 'Bad token' },
          502,
        ),
        'telegramConnect',
      ),
    ).toEqual({
      kind: 'invalidToken',
      serverMessage: 'errors.provider_auth_required',
    });

    expect(
      getIntegrationErrorDetails(
        axiosErrorWith(
          { code: 'errors.provider_not_configured' },
          503,
        ),
        'googleConnect',
      ),
    ).toEqual({
      kind: 'oauthUnavailable',
      serverMessage: 'errors.provider_not_configured',
    });
  });

  it('маппит сеть, 401, 403, 404 и 5xx', () => {
    expect(
      getIntegrationErrorDetails(new AxiosError('Network'), 'load').kind,
    ).toBe('network');
    expect(getIntegrationErrorDetails(axiosErrorWith({}, 401), 'load').kind).toBe(
      'sessionExpired',
    );
    expect(getIntegrationErrorDetails(axiosErrorWith({}, 403), 'load').kind).toBe(
      'forbidden',
    );
    expect(getIntegrationErrorDetails(axiosErrorWith({}, 404), 'load').kind).toBe(
      'notFound',
    );
    expect(getIntegrationErrorDetails(axiosErrorWith({}, 503), 'load').kind).toBe(
      'unavailable',
    );
  });

  it('распознаёт ZodError и массив сообщений сервера', () => {
    expect(
      getIntegrationErrorDetails(new ZodError([]), 'load'),
    ).toEqual({ kind: 'invalidResponse', serverMessage: null });

    expect(
      getIntegrationErrorDetails(
        axiosErrorWith({ message: ['Первая ошибка', 'Вторая ошибка'] }, 400),
        'telegramConnect',
      ).serverMessage,
    ).toBe('Первая ошибка; Вторая ошибка');
  });
});
