import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { AxiosInstance } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const post = vi.fn();
const create = vi.fn(() => ({ post }));

vi.mock('axios', () => ({
  default: { create },
  isAxiosError: (error: unknown): boolean =>
    typeof error === 'object' &&
    error !== null &&
    (error as { isAxiosError?: boolean }).isAxiosError === true,
}));

const {
  YandexAdapter,
  YANDEX_IAM_TOKEN_TTL_MS,
  buildYandexModelUri,
  resetYandexIamTokenCache,
} = await import('./yandex.adapter.js');

const IAM_TOKEN = 'iam-token-1';
const FOLDER_ID = 'b1gfolder';
const OAUTH_TOKEN = 'oauth-token-1';

function createAdapter(): InstanceType<typeof YandexAdapter> {
  return new YandexAdapter({
    modelName: 'yandexgpt-lite',
    iamToken: IAM_TOKEN,
    folderId: FOLDER_ID,
  });
}

/** Ответ completion-эндпоинта с текстом `text`. */
function completionResponse(text: string) {
  return {
    data: {
      result: {
        alternatives: [{ message: { role: 'assistant', text } }],
        usage: {
          inputTextTokens: '1',
          completionTokens: '1',
          totalTokens: '2',
        },
      },
    },
  };
}

describe('buildYandexModelUri', () => {
  it('собирает URI из каталога и имени модели', () => {
    expect(buildYandexModelUri('yandexgpt-lite', FOLDER_ID)).toBe(
      `gpt://${FOLDER_ID}/yandexgpt-lite`,
    );
  });

  it('оставляет готовый URI без изменений', () => {
    expect(buildYandexModelUri('gpt://other-folder/yandexgpt', FOLDER_ID)).toBe(
      'gpt://other-folder/yandexgpt',
    );
  });

  it('падает без каталога и без URI', () => {
    expect(() => buildYandexModelUri('yandexgpt-lite', '')).toThrow(
      /YANDEX_FOLDER_ID/,
    );
  });
});

describe('YandexAdapter', () => {
  beforeEach(() => {
    post.mockReset();
    create.mockClear();
    resetYandexIamTokenCache();
  });

  it('отправляет completion-запрос с Bearer-токеном и modelUri', async () => {
    post.mockResolvedValue({
      data: {
        result: {
          alternatives: [{ message: { role: 'assistant', text: 'Привет' } }],
          usage: {
            inputTextTokens: '12',
            completionTokens: '7',
            totalTokens: '19',
          },
        },
      },
    });
    const adapter = createAdapter();

    const response = await adapter.chat({
      messages: [new HumanMessage('привет')],
      tools: [],
      systemPrompt: 'Ты помощник',
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL:
          'https://llm.api.cloud.yandex.net/foundationModels/v1/completion',
      }),
    );

    const [path, body, config] = post.mock.calls[0] as [
      string,
      {
        modelUri: string;
        messages: { role: string; text: string }[];
        tools?: unknown;
      },
      { headers: Record<string, string> },
    ];

    expect(path).toBe('');
    expect(body.modelUri).toBe(`gpt://${FOLDER_ID}/yandexgpt-lite`);
    expect(body.messages).toEqual([
      { role: 'system', text: 'Ты помощник' },
      { role: 'user', text: 'привет' },
    ]);
    expect(config.headers.Authorization).toBe(`Bearer ${IAM_TOKEN}`);
    expect(response.content).toBe('Привет');
    expect(response.usage_metadata).toMatchObject({
      input_tokens: 12,
      output_tokens: 7,
      total_tokens: 19,
    });
    expect(response.tool_calls).toEqual([]);
  });

  it('передаёт инструменты и разбирает вызов функции', async () => {
    post.mockResolvedValue({
      data: {
        result: {
          alternatives: [
            {
              message: {
                text: '',
                toolCallList: [
                  {
                    functionCall: {
                      name: 'execute_sandbox_code',
                      arguments: '{"code":"print(1)"}',
                    },
                  },
                ],
              },
            },
          ],
          usage: {},
        },
      },
    });
    const adapter = createAdapter();
    const tool = {
      name: 'execute_sandbox_code',
      description: 'Выполняет код',
      schema: undefined,
    };

    const response = await adapter.chat({
      messages: [new SystemMessage('система'), new HumanMessage('запусти')],
      tools: [tool] as never,
      systemPrompt: '',
    });

    const [, body] = post.mock.calls[0] as [
      string,
      { tools?: { function: { name: string } }[] },
    ];

    expect(body.tools?.[0]?.function.name).toBe('execute_sandbox_code');
    expect(response.tool_calls?.[0]).toMatchObject({
      name: 'execute_sandbox_code',
      args: { code: 'print(1)' },
    });
    expect(response.content).toBe('');
  });

  it('не делает запрос без IAM-токена', async () => {
    const adapter = new YandexAdapter({
      modelName: 'yandexgpt-lite',
      iamToken: '',
      folderId: FOLDER_ID,
    });

    await expect(
      adapter.chat({
        messages: [new HumanMessage('привет')],
        tools: [],
        systemPrompt: '',
      }),
    ).rejects.toThrow(/YANDEX_IAM_TOKEN/);
    expect(post).not.toHaveBeenCalled();
  });
});

describe('YandexAdapter: OAuth → IAM', () => {
  let completionPost: ReturnType<typeof vi.fn>;
  let iamPost: ReturnType<typeof vi.fn>;

  function createOauthAdapter(): InstanceType<typeof YandexAdapter> {
    return new YandexAdapter({
      modelName: 'yandexgpt-lite',
      folderId: FOLDER_ID,
      oauthToken: OAUTH_TOKEN,
      http: { post: completionPost } as unknown as AxiosInstance,
      iamHttp: { post: iamPost } as unknown as AxiosInstance,
    });
  }

  beforeEach(() => {
    resetYandexIamTokenCache();
    completionPost = vi.fn().mockResolvedValue(completionResponse('Привет'));
    iamPost = vi.fn().mockResolvedValue({
      data: { iamToken: 'iam-from-oauth', expiresAt: '2030-01-01T00:00:00Z' },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('обменивает OAuth-токен на IAM и вызывает LLM с ним', async () => {
    const adapter = createOauthAdapter();

    await adapter.chat({
      messages: [new HumanMessage('привет')],
      tools: [],
      systemPrompt: '',
    });

    expect(iamPost).toHaveBeenCalledWith('', {
      yandexPassportOauthToken: OAUTH_TOKEN,
    });

    const [, , config] = completionPost.mock.calls[0] as [
      string,
      unknown,
      { headers: Record<string, string> },
    ];

    expect(config.headers.Authorization).toBe('Bearer iam-from-oauth');
  });

  it('кэширует IAM-токен на 11 часов между экземплярами адаптера', async () => {
    // LlmService создаёт адаптер на каждый вызов — кэш должен быть общим.
    await createOauthAdapter().chat({
      messages: [new HumanMessage('раз')],
      tools: [],
      systemPrompt: '',
    });
    await createOauthAdapter().chat({
      messages: [new HumanMessage('два')],
      tools: [],
      systemPrompt: '',
    });

    expect(iamPost).toHaveBeenCalledTimes(1);
    expect(completionPost).toHaveBeenCalledTimes(2);
  });

  it('обновляет IAM-токен после истечения 11-часового кэша', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-13T00:00:00Z'));
    iamPost.mockResolvedValue({ data: { iamToken: 'iam-1' } });
    const adapter = createOauthAdapter();

    await adapter.chat({
      messages: [new HumanMessage('раз')],
      tools: [],
      systemPrompt: '',
    });

    vi.setSystemTime(new Date(Date.now() + YANDEX_IAM_TOKEN_TTL_MS + 60_000));
    iamPost.mockResolvedValue({ data: { iamToken: 'iam-2' } });

    await adapter.chat({
      messages: [new HumanMessage('два')],
      tools: [],
      systemPrompt: '',
    });

    expect(iamPost).toHaveBeenCalledTimes(2);
    expect(
      (
        completionPost.mock.calls[1] as [
          string,
          unknown,
          { headers: Record<string, string> },
        ]
      )[2].headers.Authorization,
    ).toBe('Bearer iam-2');
  });

  it('обновляет IAM-токен и повторяет запрос после 401', async () => {
    const unauthorized = Object.assign(new Error('Unauthorized'), {
      isAxiosError: true,
      response: { status: 401 },
    });

    completionPost
      .mockRejectedValueOnce(unauthorized)
      .mockResolvedValueOnce(completionResponse('Повтор'));
    iamPost
      .mockResolvedValueOnce({ data: { iamToken: 'iam-stale' } })
      .mockResolvedValueOnce({ data: { iamToken: 'iam-fresh' } });

    const adapter = createOauthAdapter();
    const response = await adapter.chat({
      messages: [new HumanMessage('привет')],
      tools: [],
      systemPrompt: '',
    });

    expect(iamPost).toHaveBeenCalledTimes(2);
    expect(response.content).toBe('Повтор');
    expect(
      (
        completionPost.mock.calls[1] as [
          string,
          unknown,
          { headers: Record<string, string> },
        ]
      )[2].headers.Authorization,
    ).toBe('Bearer iam-fresh');
  });

  it('не вызывает LLM без статического IAM-токена и OAuth-пары', async () => {
    const adapter = new YandexAdapter({
      modelName: 'yandexgpt-lite',
      folderId: FOLDER_ID,
      http: { post: completionPost } as unknown as AxiosInstance,
      iamHttp: { post: iamPost } as unknown as AxiosInstance,
    });

    await expect(
      adapter.chat({
        messages: [new HumanMessage('привет')],
        tools: [],
        systemPrompt: '',
      }),
    ).rejects.toThrow(/YANDEX_OAUTH_TOKEN/);
    expect(completionPost).not.toHaveBeenCalled();
    expect(iamPost).not.toHaveBeenCalled();
  });
});
