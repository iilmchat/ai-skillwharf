import { AxiosError, type AxiosResponse } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import {
  bitrix24WebhookUrlSchema,
  chestnyZnakCredentialsSchema,
  chestnyZnakInnSchema,
  connectChestnyZnak,
  connectEdoIntegration,
  connectKeyIntegration,
  connectTelegram,
  diadocCredentialsSchema,
  disconnectChestnyZnak,
  disconnectEdoIntegration,
  disconnectKeyIntegration,
  fetchGoogleAuthorizationUrl,
  fetchIntegrations,
  getActiveIntegrationChannels,
  getChestnyZnakInn,
  getIntegrationErrorDetails,
  getProviderCredentialRejectionKey,
  getTelegramDisplayName,
  getWildberriesTokenExpiry,
  googleAuthorizationUrlSchema,
  integrationsSchema,
  moyskladApiTokenSchema,
  oneCCredentialsSchema,
  oneCOdataUrlSchema,
  oneCPasswordSchema,
  oneCUsernameSchema,
  PROVIDER_AUTH_REQUIRED_CODE,
  sbisCredentialsSchema,
  telegramBotTokenSchema,
  type IntegrationsState,
} from './integrations';

const { getMock, postMock, deleteMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  deleteMock: vi.fn(),
}));

vi.mock('./api', () => ({
  api: {
    get: getMock,
    post: postMock,
    delete: deleteMock,
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
  ozon: { status: 'disconnected' },
  wildberries: { status: 'disconnected' },
  midjourney: { status: 'disconnected' },
  bitrix24: { status: 'disconnected' },
  moysklad: { status: 'disconnected' },
  onec: { status: 'disconnected' },
  diadoc: { status: 'disconnected' },
  sbis: { status: 'disconnected' },
  chestny_znak: { status: 'disconnected' },
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
      ozon: { status: 'disconnected' },
      wildberries: { status: 'disconnected' },
      midjourney: { status: 'disconnected' },
      bitrix24: { status: 'disconnected' },
      moysklad: { status: 'disconnected' },
      onec: { status: 'disconnected' },
      diadoc: { status: 'disconnected' },
      sbis: { status: 'disconnected' },
      chestny_znak: { status: 'disconnected' },
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

  it('принимает срок действия WB-токена в tokenExpiresAt и expiresAt', () => {
    const state = integrationsSchema.parse({
      telegram: { status: 'disconnected' },
      google: { status: 'disconnected' },
      wildberries: {
        status: 'active',
        tokenExpiresAt: '2027-05-12T00:00:00.000Z',
      },
    });

    expect(getWildberriesTokenExpiry(state.wildberries)).toBe(
      '2027-05-12T00:00:00.000Z',
    );
    expect(
      getWildberriesTokenExpiry({
        status: 'active',
        expiresAt: '2027-05-12T00:00:00.000Z',
      }),
    ).toBe('2027-05-12T00:00:00.000Z');
    expect(getWildberriesTokenExpiry({ status: 'active' })).toBeNull();
  });

  it('считает Битрикс24 и МойСклад отключёнными, если API о них не знает', () => {
    const state = integrationsSchema.parse({
      telegram: { status: 'active' },
      google: { status: 'active' },
    });

    expect(state.bitrix24).toEqual({ status: 'disconnected' });
    expect(state.moysklad).toEqual({ status: 'disconnected' });

    // Ошибку провайдера из API схема пропускает как есть.
    expect(
      integrationsSchema.parse({
        telegram: { status: 'disconnected' },
        google: { status: 'disconnected' },
        bitrix24: { status: 'error', error: 'errors.bitrix24_webhook_expired' },
      }).bitrix24,
    ).toEqual({ status: 'error', error: 'errors.bitrix24_webhook_expired' });
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

describe('bitrix24WebhookUrlSchema', () => {
  it('принимает только абсолютный https-вебхук', () => {
    const webhook = 'https://portal.bitrix24.ru/rest/1/abc123def/';

    expect(bitrix24WebhookUrlSchema.parse(webhook)).toBe(webhook);
    expect(
      bitrix24WebhookUrlSchema.safeParse(
        'http://portal.bitrix24.ru/rest/1/abc123def/',
      ).success,
    ).toBe(false);
    expect(
      bitrix24WebhookUrlSchema.safeParse('portal.bitrix24.ru/rest/1/abc/')
        .success,
    ).toBe(false);
    expect(
      bitrix24WebhookUrlSchema.safeParse('javascript:alert(1)').success,
    ).toBe(false);
  });

  it('не пропускает пустое значение и обрезает пробелы', () => {
    expect(bitrix24WebhookUrlSchema.safeParse('').success).toBe(false);
    expect(bitrix24WebhookUrlSchema.safeParse('   ').success).toBe(false);
    expect(
      bitrix24WebhookUrlSchema.parse(
        '  https://portal.bitrix24.ru/rest/1/abc123def/ \n',
      ),
    ).toBe('https://portal.bitrix24.ru/rest/1/abc123def/');
  });
});

describe('moyskladApiTokenSchema', () => {
  it('отклоняет пустой и заведомо неполный токен', () => {
    expect(moyskladApiTokenSchema.safeParse('').success).toBe(false);
    expect(moyskladApiTokenSchema.safeParse('   ').success).toBe(false);
    expect(moyskladApiTokenSchema.safeParse('short').success).toBe(false);
  });

  it('принимает токен и убирает пробелы по краям', () => {
    expect(moyskladApiTokenSchema.parse('  ms-token-1234567890  ')).toBe(
      'ms-token-1234567890',
    );
  });
});

describe('1С: OData URL (Sprint 32)', () => {
  it('принимает абсолютные http:// и https:// адреса и обрезает пробелы', () => {
    expect(oneCOdataUrlSchema.parse('https://company.ru')).toBe(
      'https://company.ru',
    );
    expect(oneCOdataUrlSchema.parse('  http://1c.local/odata  ')).toBe(
      'http://1c.local/odata',
    );
  });

  it('отклоняет относительные пути, чужие схемы и пустоту', () => {
    expect(oneCOdataUrlSchema.safeParse('company.ru/odata').success).toBe(false);
    expect(oneCOdataUrlSchema.safeParse('javascript:alert(1)').success).toBe(
      false,
    );
    expect(oneCOdataUrlSchema.safeParse('ftp://company.ru').success).toBe(false);
    expect(
      oneCOdataUrlSchema.safeParse('https://user:pass@company.ru').success,
    ).toBe(false);
    expect(oneCOdataUrlSchema.safeParse('   ').success).toBe(false);
  });
});

describe('1С: логин и пароль (Sprint 32)', () => {
  it('требует непустые значения и убирает пробелы по краям', () => {
    expect(oneCUsernameSchema.parse(' buf  ')).toBe('buf');
    expect(oneCPasswordSchema.parse('  secret  ')).toBe('secret');
    expect(oneCUsernameSchema.safeParse('   ').success).toBe(false);
    expect(oneCPasswordSchema.safeParse('').success).toBe(false);
  });

  it('валидирует всё тело подключения одной схемой', () => {
    const credentials = {
      odataUrl: 'https://company.ru',
      username: 'buf',
      password: 'secret',
    };

    expect(oneCCredentialsSchema.parse(credentials)).toEqual(credentials);
    expect(
      oneCCredentialsSchema.safeParse({ ...credentials, odataUrl: 'nope' })
        .success,
    ).toBe(false);
    expect(
      oneCCredentialsSchema.safeParse({ ...credentials, password: '' }).success,
    ).toBe(false);
  });

  it('считает 1С отключённой, если API о ней не знает', () => {
    const state = integrationsSchema.parse({
      telegram: { status: 'active' },
      google: { status: 'disconnected' },
    });

    expect(state.onec).toEqual({ status: 'disconnected' });
    expect(
      integrationsSchema.parse({
        telegram: { status: 'disconnected' },
        google: { status: 'disconnected' },
        onec: {
          status: 'active',
          odataUrl: 'https://company.ru',
          source: 'user',
        },
      }).onec,
    ).toEqual({
      status: 'active',
      odataUrl: 'https://company.ru',
      source: 'user',
    });
  });
});

describe('integration API', () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
    deleteMock.mockReset();
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

  it('запрашивает OAuth URL по пути /authorization-url', async () => {
    getMock.mockResolvedValueOnce({
      data: { url: 'https://accounts.google.com/o/oauth2/v2/auth?x=3' },
    });

    await fetchGoogleAuthorizationUrl();

    expect(getMock).toHaveBeenCalledWith(
      '/integrations/google/authorization-url',
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

  it('подключает Ozon с Client ID и API Key', async () => {
    await connectKeyIntegration({
      provider: 'ozon',
      clientId: 'client-1',
      apiKey: 'secret-key',
    });

    expect(postMock).toHaveBeenCalledWith('/integrations/ozon', {
      clientId: 'client-1',
      apiKey: 'secret-key',
    });
  });

  it('подключает Wildberries только API Token', async () => {
    await connectKeyIntegration({
      provider: 'wildberries',
      apiToken: 'wb-token',
    });

    expect(postMock).toHaveBeenCalledWith('/integrations/wildberries', {
      apiToken: 'wb-token',
    });
  });

  it('подключает Midjourney только TT-API-KEY и отключает провайдера', async () => {
    await connectKeyIntegration({
      provider: 'midjourney',
      apiKey: 'mj-key',
    });
    await disconnectKeyIntegration('midjourney');

    expect(postMock).toHaveBeenCalledWith('/integrations/midjourney', {
      apiKey: 'mj-key',
    });
    expect(deleteMock).toHaveBeenCalledWith('/integrations/midjourney');
  });

  it('подключает Битрикс24 по вебхуку и отключает его', async () => {
    await connectKeyIntegration({
      provider: 'bitrix24',
      webhookUrl: 'https://portal.bitrix24.ru/rest/1/abc123def/',
    });
    await disconnectKeyIntegration('bitrix24');

    expect(postMock).toHaveBeenCalledWith('/integrations/bitrix24', {
      webhookUrl: 'https://portal.bitrix24.ru/rest/1/abc123def/',
    });
    expect(deleteMock).toHaveBeenCalledWith('/integrations/bitrix24');
  });

  it('подключает МойСклад по API Token и отключает его', async () => {
    await connectKeyIntegration({
      provider: 'moysklad',
      apiToken: 'ms-token-1234567890',
    });
    await disconnectKeyIntegration('moysklad');

    expect(postMock).toHaveBeenCalledWith('/integrations/moysklad', {
      apiToken: 'ms-token-1234567890',
    });
    expect(deleteMock).toHaveBeenCalledWith('/integrations/moysklad');
  });

  it('подключает 1С по OData URL, логину и паролю и отключает её', async () => {
    await connectKeyIntegration({
      provider: '1c',
      odataUrl: 'https://company.ru',
      username: 'buf',
      password: 'secret',
    });
    await disconnectKeyIntegration('1c');

    expect(postMock).toHaveBeenCalledWith('/integrations/1c', {
      odataUrl: 'https://company.ru',
      username: 'buf',
      password: 'secret',
    });
    expect(deleteMock).toHaveBeenCalledWith('/integrations/1c');
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
        ozon: { status: 'disconnected' },
        wildberries: { status: 'disconnected' },
        midjourney: { status: 'disconnected' },
        bitrix24: { status: 'disconnected' },
        moysklad: { status: 'disconnected' },
        onec: { status: 'disconnected' },
        diadoc: { status: 'disconnected' },
        sbis: { status: 'disconnected' },
        chestny_znak: { status: 'disconnected' },
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

  it('маппит 401 Telegram в invalidToken, а 400 оставляет fallback', () => {
    expect(
      getIntegrationErrorDetails(
        axiosErrorWith(
          { code: 'errors.provider_auth_required', message: 'Unauthorized' },
          401,
        ),
        'telegramConnect',
      ),
    ).toEqual({
      kind: 'invalidToken',
      serverMessage: 'errors.provider_auth_required',
    });

    // Статус 401 сам по себе достаточен: код ошибки может отсутствовать.
    expect(
      getIntegrationErrorDetails(
        axiosErrorWith({ message: 'Unauthorized' }, 401),
        'telegramConnect',
      ).kind,
    ).toBe('invalidToken');

    // 400 остаётся fallback-веткой для неверного токена.
    expect(
      getIntegrationErrorDetails(
        axiosErrorWith({ message: 'Invalid bot token' }, 400),
        'telegramConnect',
      ).kind,
    ).toBe('invalidToken');
  });

  it('маппит ошибки Ozon/WB/Midjourney/Б24/МС в invalidCredentials', () => {
    expect(
      getIntegrationErrorDetails(
        axiosErrorWith(
          { code: 'errors.provider_auth_required', message: 'Bad keys' },
          401,
        ),
        'ozonConnect',
      ),
    ).toEqual({
      kind: 'invalidCredentials',
      serverMessage: 'errors.provider_auth_required',
    });

    expect(
      getIntegrationErrorDetails(
        axiosErrorWith({ message: 'Bad keys' }, 400),
        'wildberriesConnect',
      ).kind,
    ).toBe('invalidCredentials');

    expect(
      getIntegrationErrorDetails(
        axiosErrorWith({ message: 'Bad key' }, 403),
        'midjourneyConnect',
      ).kind,
    ).toBe('forbidden');

    expect(
      getIntegrationErrorDetails(
        axiosErrorWith({ message: 'Bad key' }, 401),
        'midjourneyConnect',
      ).kind,
    ).toBe('sessionExpired');

    // Треки K/L: Битрикс24 и МойСклад отвечают тем же invalidCredentials.
    expect(
      getIntegrationErrorDetails(
        axiosErrorWith({ message: 'Bad webhook' }, 400),
        'bitrix24Connect',
      ).kind,
    ).toBe('invalidCredentials');

    expect(
      getIntegrationErrorDetails(
        axiosErrorWith({ code: 'errors.provider_auth_required' }, 502),
        'moyskladConnect',
      ).kind,
    ).toBe('invalidCredentials');
  });

  it('маппит ошибки подключения 1С в invalidCredentials', () => {
    expect(
      getIntegrationErrorDetails(
        axiosErrorWith(
          { code: PROVIDER_AUTH_REQUIRED_CODE, message: 'Bad credentials' },
          502,
        ),
        '1cConnect',
      ),
    ).toEqual({
      kind: 'invalidCredentials',
      serverMessage: PROVIDER_AUTH_REQUIRED_CODE,
    });
    expect(
      getIntegrationErrorDetails(
        axiosErrorWith({ message: 'Unauthorized' }, 401),
        '1cConnect',
      ).kind,
    ).toBe('sessionExpired');
  });

  it('маппит provider_unavailable в unavailable', () => {
    expect(
      getIntegrationErrorDetails(
        axiosErrorWith(
          {
            code: 'errors.provider_unavailable',
            message: 'Ozon API is unavailable',
          },
          502,
        ),
        'ozonConnect',
      ),
    ).toEqual({
      kind: 'unavailable',
      serverMessage: 'errors.provider_unavailable',
    });
  });

  it('404 от ещё не готового endpoint не ломает карточку', () => {
    expect(
      getIntegrationErrorDetails(
        axiosErrorWith({ message: 'Cannot POST /integrations/ozon' }, 404),
        'ozonConnect',
      ),
    ).toEqual({
      kind: 'notFound',
      serverMessage: 'Cannot POST /integrations/ozon',
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

describe('getProviderCredentialRejectionKey', () => {
  it('даёт отдельные сообщения для Битрикс24 и МойСклада', () => {
    expect(getProviderCredentialRejectionKey('bitrix24Connect')).toBe(
      'settings.integrations.bitrix24.webhookRejected',
    );
    expect(getProviderCredentialRejectionKey('moyskladConnect')).toBe(
      'settings.integrations.moysklad.tokenRejected',
    );
    expect(getProviderCredentialRejectionKey('1cConnect')).toBe(
      'settings.integrations.oneC.credentialsRejected',
    );
  });

  it('для остальных карточек оставляет общий текст', () => {
    expect(getProviderCredentialRejectionKey('ozonConnect')).toBeNull();
    expect(getProviderCredentialRejectionKey('wildberriesConnect')).toBeNull();
    expect(getProviderCredentialRejectionKey('bitrix24Disconnect')).toBeNull();
    expect(getProviderCredentialRejectionKey('load')).toBeNull();
  });
});

describe('live-проверка ключей Битрикс24/МойСклад', () => {
  it('400 errors.provider_auth_required → invalidCredentials с кодом', () => {
    const error = axiosErrorWith(
      { code: PROVIDER_AUTH_REQUIRED_CODE, message: 'Webhook rejected' },
      400,
    );

    expect(getIntegrationErrorDetails(error, 'bitrix24Connect')).toEqual({
      kind: 'invalidCredentials',
      serverMessage: PROVIDER_AUTH_REQUIRED_CODE,
    });
    expect(getIntegrationErrorDetails(error, 'moyskladConnect')).toEqual({
      kind: 'invalidCredentials',
      serverMessage: PROVIDER_AUTH_REQUIRED_CODE,
    });
  });

  it('1С: 400 provider_auth_required → invalidCredentials с кодом', () => {
    const error = axiosErrorWith(
      { code: PROVIDER_AUTH_REQUIRED_CODE, message: '1C rejected login' },
      400,
    );

    expect(getIntegrationErrorDetails(error, '1cConnect')).toEqual({
      kind: 'invalidCredentials',
      serverMessage: PROVIDER_AUTH_REQUIRED_CODE,
    });
  });

  it('502 errors.provider_unavailable → unavailable с локализуемым кодом', () => {
    expect(
      getIntegrationErrorDetails(
        axiosErrorWith({ code: 'errors.provider_unavailable' }, 502),
        'bitrix24Connect',
      ),
    ).toEqual({
      kind: 'unavailable',
      serverMessage: 'errors.provider_unavailable',
    });
  });
});

describe('ЭДО: Контур.Диадок и СБИС (Sprint 41)', () => {
  const DIADOC = { apiKey: 'api-key', boxId: 'box-1', token: 'diadoc-token' };
  const SBIS = { token: 'sbis-session', boxId: '7700000000' };

  beforeEach(() => {
    postMock.mockReset();
    deleteMock.mockReset();
  });

  it('проверяет обязательные поля обеих форм', () => {
    expect(diadocCredentialsSchema.parse(DIADOC)).toEqual(DIADOC);
    expect(sbisCredentialsSchema.parse(SBIS)).toEqual(SBIS);
    expect(
      diadocCredentialsSchema.safeParse({ ...DIADOC, boxId: '' }).success,
    ).toBe(false);
    expect(sbisCredentialsSchema.safeParse({ token: '' }).success).toBe(false);
  });

  it('добавляет статусы EDO в общий ответ /integrations', () => {
    const state = integrationsSchema.parse({
      telegram: { status: 'active' },
      google: { status: 'disconnected' },
      diadoc: { status: 'active', boxId: 'box-1' },
    });

    expect(state.diadoc).toEqual({ status: 'active', boxId: 'box-1' });
    expect(state.sbis).toEqual({ status: 'disconnected' });
  });

  it('подключает Диадок и СБИС отдельными POST-запросами', async () => {
    await connectEdoIntegration({ provider: 'diadoc', ...DIADOC });
    expect(postMock).toHaveBeenCalledWith('/integrations/diadoc', DIADOC);

    await connectEdoIntegration({ provider: 'sbis', ...SBIS });
    expect(postMock).toHaveBeenCalledWith('/integrations/sbis', SBIS);
  });

  it('не отправляет невалидную форму ЭДО', async () => {
    await expect(
      connectEdoIntegration({ provider: 'diadoc', ...DIADOC, token: '' }),
    ).rejects.toBeInstanceOf(ZodError);
    expect(postMock).not.toHaveBeenCalled();
  });

  it('отключает провайдеров отдельными DELETE-запросами', async () => {
    await disconnectEdoIntegration('diadoc');
    await disconnectEdoIntegration('sbis');
    expect(deleteMock).toHaveBeenNthCalledWith(1, '/integrations/diadoc');
    expect(deleteMock).toHaveBeenNthCalledWith(2, '/integrations/sbis');
  });

  it('сопоставляет отказ ключей с карточкой провайдера', () => {
    expect(
      getProviderCredentialRejectionKey('diadocConnect'),
    ).toBe('settings.integrations.diadoc.credentialsRejected');
    expect(getProviderCredentialRejectionKey('sbisConnect')).toBe(
      'settings.integrations.sbis.credentialsRejected',
    );
  });
});

describe('ГИС МТ «Честный ЗНАК» (Sprint 42)', () => {
  const CREDENTIALS = { token: 'true-api-token', inn: '7700000000' };

  beforeEach(() => {
    postMock.mockReset();
    deleteMock.mockReset();
  });

  it('принимает ИНН 10 и 12 цифр', () => {
    expect(chestnyZnakInnSchema.parse('7700000000')).toBe('7700000000');
    expect(chestnyZnakInnSchema.parse('500100732259')).toBe('500100732259');
    expect(chestnyZnakCredentialsSchema.parse(CREDENTIALS)).toEqual(CREDENTIALS);
  });

  it('отклоняет невалидный ИНН и пустой токен', () => {
    expect(chestnyZnakInnSchema.safeParse('12345').success).toBe(false);
    expect(chestnyZnakInnSchema.safeParse('7700000000a').success).toBe(false);
    expect(chestnyZnakInnSchema.safeParse('7700000000000').success).toBe(false);
    expect(
      chestnyZnakCredentialsSchema.safeParse({ ...CREDENTIALS, token: '' })
        .success,
    ).toBe(false);
  });

  it('добавляет статус в общий ответ /integrations', () => {
    const state = integrationsSchema.parse({
      telegram: { status: 'active' },
      google: { status: 'disconnected' },
      chestny_znak: { status: 'active', inn: '7700000000' },
    });

    expect(state.chestny_znak).toEqual({ status: 'active', inn: '7700000000' });
  });

  it('читает маскированный ИНН из статуса API', () => {
    const state = integrationsSchema.parse({
      telegram: { status: 'disconnected' },
      google: { status: 'disconnected' },
      chestny_znak: { status: 'active', innMasked: '7700****00' },
    });

    expect(getChestnyZnakInn(state.chestny_znak)).toBe('7700****00');
  });

  it('подключает и отключает провайдера отдельными запросами', async () => {
    await connectChestnyZnak(CREDENTIALS);
    expect(postMock).toHaveBeenCalledWith(
      '/integrations/chestny_znak',
      CREDENTIALS,
    );

    await disconnectChestnyZnak();
    expect(deleteMock).toHaveBeenCalledWith('/integrations/chestny_znak');
  });

  it('не отправляет запрос с невалидным ИНН', async () => {
    await expect(
      connectChestnyZnak({ ...CREDENTIALS, inn: 'bad' }),
    ).rejects.toBeInstanceOf(ZodError);
    expect(postMock).not.toHaveBeenCalled();
  });

  it('использует отдельный ключ ошибки для карточки', () => {
    expect(getProviderCredentialRejectionKey('chestnyZnakConnect')).toBe(
      'settings.integrations.chestnyZnak.credentialsRejected',
    );
  });
});
