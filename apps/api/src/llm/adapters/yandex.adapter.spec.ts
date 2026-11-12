import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const post = vi.fn();
const create = vi.fn(() => ({ post }));

vi.mock('axios', () => ({
  default: { create },
  isAxiosError: (error: unknown): boolean =>
    typeof error === 'object' &&
    error !== null &&
    (error as { isAxiosError?: boolean }).isAxiosError === true,
}));

const { YandexAdapter, buildYandexModelUri } =
  await import('./yandex.adapter.js');

const IAM_TOKEN = 'iam-token-1';
const FOLDER_ID = 'b1gfolder';

function createAdapter(): InstanceType<typeof YandexAdapter> {
  return new YandexAdapter({
    modelName: 'yandexgpt-lite',
    iamToken: IAM_TOKEN,
    folderId: FOLDER_ID,
  });
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
