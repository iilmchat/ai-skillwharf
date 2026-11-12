import { AIMessage } from '@langchain/core/messages';
import { Injectable, Logger } from '@nestjs/common';
import axios, {
  isAxiosError,
  type AxiosInstance,
  type AxiosResponse,
} from 'axios';
import { randomUUID } from 'node:crypto';
import {
  parseToolArguments,
  toFunctionSpecs,
  toNativeMessages,
  type NativeChatRequest,
  type NativeProviderAdapter,
} from './types.js';

/** OAuth-эндпоинт GigaChat. */
export const GIGACHAT_OAUTH_URL =
  'https://ngw.devices.sberbank.ru:9443/api/v2/oauth';

/** Эндпоинт чата GigaChat. */
export const GIGACHAT_CHAT_URL =
  'https://gigachat.devices.sberbank.ru/api/v1/chat/completions';

/** Scope по умолчанию: физические лица. */
export const GIGACHAT_DEFAULT_SCOPE = 'GIGACHAT_API_PERS';

/** Токен живёт 30 минут; обновляем за минуту до истечения. */
export const GIGACHAT_TOKEN_TTL_MS = 30 * 60 * 1000;

/** Запас перед истечением токена, чтобы не отправить протухший запрос. */
export const GIGACHAT_TOKEN_SKEW_MS = 60 * 1000;

/** Вызов функции в ответе GigaChat. */
export interface GigaChatFunctionCall {
  name?: string;
  arguments?: unknown;
}

/**
 * GigaChat возвращает не более одного вызова функции за ход. Если провайдер
 * всё же прислал несколько, оставляем первый, а остальные логируем: граф
 * агента всё равно выполнит их последовательно на следующих шагах.
 */
export function collapseParallelToolCalls(
  calls: GigaChatFunctionCall[],
  logger?: { warn: (message: string) => void },
): GigaChatFunctionCall[] {
  if (calls.length <= 1) {
    return calls;
  }

  logger?.warn(
    `GigaChat вернул ${calls.length} вызова функций; оставляем первый, остальные уйдут следующим ходом`,
  );

  return calls.slice(0, 1);
}

/** Ответ OAuth GigaChat. */
interface GigaChatTokenResponse {
  access_token?: string;
  expires_at?: number;
}

/** Ответ чата GigaChat. */
interface GigaChatChatResponse {
  choices?: {
    message?: {
      content?: string;
      function_call?: GigaChatFunctionCall;
      function_calls?: GigaChatFunctionCall[];
    };
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

@Injectable()
export class GigaChatAdapter implements NativeProviderAdapter {
  readonly provider = 'GigaChat';
  private readonly logger = new Logger(GigaChatAdapter.name);
  private readonly oauthHttp: AxiosInstance;
  private readonly chatHttp: AxiosInstance;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly scope: string;
  private readonly model: string;
  private cachedToken: { token: string; expiresAt: number } | null = null;

  constructor(
    options: {
      clientId?: string;
      clientSecret?: string;
      scope?: string;
      model?: string;
      oauthHttp?: AxiosInstance;
      chatHttp?: AxiosInstance;
    } = {},
  ) {
    this.clientId = options.clientId ?? process.env.GIGACHAT_CLIENT_ID ?? '';
    this.clientSecret =
      options.clientSecret ?? process.env.GIGACHAT_CLIENT_SECRET ?? '';
    this.scope = options.scope ?? GIGACHAT_DEFAULT_SCOPE;
    this.model = options.model ?? 'GigaChat';
    this.oauthHttp =
      options.oauthHttp ??
      axios.create({ baseURL: GIGACHAT_OAUTH_URL, timeout: 15_000 });
    this.chatHttp =
      options.chatHttp ??
      axios.create({ baseURL: GIGACHAT_CHAT_URL, timeout: 60_000 });
  }

  /** Заданы ли ключи приложения. */
  isConfigured(): boolean {
    return this.clientId !== '' && this.clientSecret !== '';
  }

  /** Сбрасывает кэш токена (например, после 401). */
  resetToken(): void {
    this.cachedToken = null;
  }

  async chat(request: NativeChatRequest): Promise<AIMessage> {
    if (!this.isConfigured()) {
      throw new Error(
        'GigaChat не настроен: отсутствуют GIGACHAT_CLIENT_ID/GIGACHAT_CLIENT_SECRET',
      );
    }

    const functions = toFunctionSpecs(request.tools);
    const body = {
      model: this.model,
      temperature: 0.7,
      messages: toNativeMessages(request.messages, request.systemPrompt),
      ...(functions.length > 0
        ? { functions, function_call: 'auto' as const }
        : {}),
    };

    let data = await this.send<GigaChatChatResponse>(body);

    if (data === null) {
      // Токен мог истечь раньше времени — обновляем и пробуем ещё раз.
      this.resetToken();
      data = await this.send<GigaChatChatResponse>(body);
    }

    const message = data?.choices?.[0]?.message;
    const usage = data?.usage;
    const rawCalls = message?.function_calls ?? [];
    const singleCall = message?.function_call;
    const calls = collapseParallelToolCalls(
      singleCall ? [singleCall] : rawCalls,
      this.logger,
    );

    return new AIMessage({
      content: message?.content ?? '',
      tool_calls: calls
        .filter((call) => typeof call.name === 'string')
        .map((call) => ({
          name: call.name ?? '',
          args: parseToolArguments(call.arguments),
          id: '',
          type: 'tool_call' as const,
        })),
      usage_metadata: {
        input_tokens: usage?.prompt_tokens ?? 0,
        output_tokens: usage?.completion_tokens ?? 0,
        total_tokens: usage?.total_tokens ?? 0,
      },
    });
  }

  /** Отправляет запрос чата; на 401 возвращает `null` для повтора. */
  private async send<T>(body: unknown): Promise<T | null> {
    const token = await this.getToken();

    try {
      const response: AxiosResponse<T> = await this.chatHttp.post<T>('', body, {
        headers: { Authorization: `Bearer ${token}` },
      });

      return response.data;
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 401) {
        this.logger.warn('GigaChat: токен отклонён, обновляем OAuth-токен');

        return null;
      }

      this.logger.error(`GigaChat: ошибка запроса: ${describe(error)}`);
      throw error;
    }
  }

  /** Возвращает закэшированный токен или получает новый по OAuth. */
  async getToken(): Promise<string> {
    const now = Date.now();

    if (
      this.cachedToken !== null &&
      this.cachedToken.expiresAt - GIGACHAT_TOKEN_SKEW_MS > now
    ) {
      return this.cachedToken.token;
    }

    const { data } = await this.oauthHttp.post<GigaChatTokenResponse>(
      '',
      `scope=${encodeURIComponent(this.scope)}`,
      {
        headers: {
          Authorization: `Basic ${Buffer.from(
            `${this.clientId}:${this.clientSecret}`,
          ).toString('base64')}`,
          RqUID: randomUUID(),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      },
    );

    if (!data.access_token) {
      throw new Error('GigaChat: OAuth не вернул access_token');
    }

    this.cachedToken = {
      token: data.access_token,
      expiresAt: data.expires_at ?? now + GIGACHAT_TOKEN_TTL_MS,
    };

    return data.access_token;
  }
}

function describe(error: unknown): string {
  if (isAxiosError(error)) {
    const status = error.response?.status ?? 0;

    return `HTTP ${status}`;
  }

  return error instanceof Error ? error.message : String(error);
}
