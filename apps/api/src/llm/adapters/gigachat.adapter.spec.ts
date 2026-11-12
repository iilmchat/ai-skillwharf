import { HumanMessage } from '@langchain/core/messages';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const oauthPost = vi.fn();
const chatPost = vi.fn();
const create = vi.fn();

vi.mock('axios', () => ({
  default: { create },
  isAxiosError: (error: unknown): boolean =>
    typeof error === 'object' &&
    error !== null &&
    (error as { isAxiosError?: boolean }).isAxiosError === true,
}));

const { GigaChatAdapter, collapseParallelToolCalls } =
  await import('./gigachat.adapter.js');

const CLIENT_ID = 'client-id';
const CLIENT_SECRET = 'client-secret';
const ACCESS_TOKEN = 'access-token-1';

function createAdapter(): InstanceType<typeof GigaChatAdapter> {
  return new GigaChatAdapter({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    model: 'GigaChat',
  });
}

function mockOauth(): void {
  oauthPost.mockResolvedValue({
    data: {
      access_token: ACCESS_TOKEN,
      expires_at: Date.now() + 30 * 60 * 1000,
    },
  });
}

function mockChat(content = 'Привет'): void {
  chatPost.mockResolvedValue({
    data: {
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  });
}

describe('GigaChatAdapter', () => {
  beforeEach(() => {
    oauthPost.mockReset();
    chatPost.mockReset();
    create.mockReset();
    // Первый create — OAuth-клиент, второй — клиент чата.
    create
      .mockReturnValueOnce({ post: oauthPost })
      .mockReturnValueOnce({ post: chatPost });
  });

  it('получает OAuth-токен с Basic-авторизацией и RqUID', async () => {
    mockOauth();
    mockChat();
    const adapter = createAdapter();

    await adapter.chat({
      messages: [new HumanMessage('привет')],
      tools: [],
      systemPrompt: '',
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth',
      }),
    );
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        baseURL: 'https://gigachat.devices.sberbank.ru/api/v1/chat/completions',
      }),
    );

    const [path, body, config] = oauthPost.mock.calls[0] as [
      string,
      string,
      { headers: Record<string, string> },
    ];

    expect(path).toBe('');
    expect(body).toBe('scope=GIGACHAT_API_PERS');
    expect(config.headers.Authorization).toBe(
      `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
    );
    expect(config.headers.RqUID).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(config.headers['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
  });

  it('вызывает чат с Bearer-токеном и разбирает ответ', async () => {
    mockOauth();
    mockChat('Привет');
    const adapter = createAdapter();

    const response = await adapter.chat({
      messages: [new HumanMessage('привет')],
      tools: [],
      systemPrompt: 'Ты помощник',
    });

    const [path, body, config] = chatPost.mock.calls[0] as [
      string,
      { model: string; messages: { role: string; text: string }[] },
      { headers: Record<string, string> },
    ];

    expect(path).toBe('');
    expect(body.model).toBe('GigaChat');
    expect(body.messages).toEqual([
      { role: 'system', text: 'Ты помощник' },
      { role: 'user', text: 'привет' },
    ]);
    expect(config.headers.Authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(response.content).toBe('Привет');
    expect(response.usage_metadata).toMatchObject({
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
    });
  });

  it('кэширует токен между запросами', async () => {
    mockOauth();
    mockChat();
    const adapter = createAdapter();

    await adapter.chat({
      messages: [new HumanMessage('первый')],
      tools: [],
      systemPrompt: '',
    });
    await adapter.chat({
      messages: [new HumanMessage('второй')],
      tools: [],
      systemPrompt: '',
    });

    expect(oauthPost).toHaveBeenCalledTimes(1);
    expect(chatPost).toHaveBeenCalledTimes(2);
  });

  it('обновляет токен и повторяет запрос после 401', async () => {
    mockOauth();
    chatPost
      .mockRejectedValueOnce({
        isAxiosError: true,
        message: 'Request failed with status code 401',
        response: { status: 401 },
      })
      .mockResolvedValueOnce({
        data: {
          choices: [{ message: { content: 'Ответ' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
      });
    const adapter = createAdapter();

    const response = await adapter.chat({
      messages: [new HumanMessage('привет')],
      tools: [],
      systemPrompt: '',
    });

    expect(oauthPost).toHaveBeenCalledTimes(2);
    expect(chatPost).toHaveBeenCalledTimes(2);
    expect(response.content).toBe('Ответ');
  });

  it('разбирает function_call и оставляет один вызов', async () => {
    mockOauth();
    chatPost.mockResolvedValue({
      data: {
        choices: [
          {
            message: {
              content: '',
              function_call: {
                name: 'execute_sandbox_code',
                arguments: '{"code":"print(1)"}',
              },
            },
          },
        ],
        usage: {},
      },
    });
    const adapter = createAdapter();

    const response = await adapter.chat({
      messages: [new HumanMessage('запусти')],
      tools: [
        {
          name: 'execute_sandbox_code',
          description: 'Выполняет код',
          schema: undefined,
        },
      ] as never,
      systemPrompt: '',
    });

    const [, body] = chatPost.mock.calls[0] as [
      string,
      { functions?: { name: string }[]; function_call?: string },
    ];

    expect(body.functions?.[0]?.name).toBe('execute_sandbox_code');
    expect(body.function_call).toBe('auto');
    expect(response.tool_calls).toHaveLength(1);
    expect(response.tool_calls?.[0]).toMatchObject({
      name: 'execute_sandbox_code',
      args: { code: 'print(1)' },
    });
  });

  it('не делает запрос без ключей приложения', async () => {
    const adapter = new GigaChatAdapter({ clientId: '', clientSecret: '' });

    await expect(
      adapter.chat({
        messages: [new HumanMessage('привет')],
        tools: [],
        systemPrompt: '',
      }),
    ).rejects.toThrow(/GIGACHAT_CLIENT_ID/);
    expect(oauthPost).not.toHaveBeenCalled();
  });
});

describe('collapseParallelToolCalls', () => {
  it('оставляет один вызов и предупреждает', () => {
    const warn = vi.fn();
    const calls = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];

    expect(collapseParallelToolCalls(calls, { warn })).toEqual([{ name: 'a' }]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('3 вызова'));
  });

  it('не трогает одиночный или пустой список', () => {
    expect(collapseParallelToolCalls([{ name: 'a' }])).toEqual([{ name: 'a' }]);
    expect(collapseParallelToolCalls([])).toEqual([]);
  });
});
