import { AIMessage } from '@langchain/core/messages';
import { Injectable, Logger } from '@nestjs/common';
import axios, {
  isAxiosError,
  type AxiosInstance,
  type AxiosResponse,
} from 'axios';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import {
  parseToolArguments,
  toFunctionSpecs,
  toNativeMessages,
  type NativeChatRequest,
  type NativeProviderAdapter,
  type NativeStreamDelta,
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

/**
 * Таймаут простоя SSE-стрима: если провайдер не присылает данные дольше,
 * соединение закрывается, и `LlmService` может уйти в нестриминговый fallback.
 */
export const GIGACHAT_STREAM_IDLE_TIMEOUT_MS = 30_000;

/** Использование токенов в стрим-чанке (финальный чанк GigaChat). */
const GigaChatUsageSchema = z.object({
  prompt_tokens: z.number().optional(),
  completion_tokens: z.number().optional(),
  total_tokens: z.number().optional(),
});

type GigaChatUsage = z.infer<typeof GigaChatUsageSchema>;

/** Накопитель текста, вызова функции и usage во время SSE-стрима. */
interface StreamAccumulator {
  content: string;
  functionName: string;
  functionArguments: string;
  usage?: GigaChatUsage;
}

const GigaChatFunctionCallSchema = z.object({
  name: z.string().optional(),
  arguments: z.string().optional(),
});

const GigaChatStreamDeltaSchema = z.object({
  role: z.string().optional(),
  content: z.string().optional(),
  function_call: GigaChatFunctionCallSchema.optional(),
});

/** Один чанк SSE-стрима GigaChat (формат `chat.completion.chunk`). */
const GigaChatStreamChunkSchema = z.object({
  choices: z
    .array(
      z.object({
        delta: GigaChatStreamDeltaSchema.optional(),
        index: z.number().optional(),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .optional(),
  usage: GigaChatUsageSchema.optional(),
});

/** Ошибка, присланная GigaChat внутри стрима. */
const GigaChatStreamErrorSchema = z.object({
  error: z.object({
    message: z.string().optional(),
    code: z.union([z.string(), z.number()]).optional(),
    type: z.string().optional(),
  }),
});

/** Разобранное SSE-сообщение: чанк или ошибка провайдера. */
export type GigaChatStreamPayload =
  | { kind: 'chunk'; chunk: z.infer<typeof GigaChatStreamChunkSchema> }
  | { kind: 'error'; message: string };

/**
 * Валидирует `data:`-payload стрима GigaChat Zod-схемой. Возвращает чанк
 * либо безопасное сообщение об ошибке провайдера (без секретов и токенов).
 */
export function parseGigaChatStreamPayload(
  payload: string,
): GigaChatStreamPayload {
  let decoded: unknown;

  try {
    decoded = JSON.parse(payload);
  } catch {
    return { kind: 'error', message: 'некорректный JSON в SSE-чанке' };
  }

  const providerError = GigaChatStreamErrorSchema.safeParse(decoded);

  if (providerError.success) {
    return {
      kind: 'error',
      message: providerError.data.error.message ?? 'ошибка провайдера',
    };
  }

  const chunk = GigaChatStreamChunkSchema.safeParse(decoded);

  if (!chunk.success) {
    return { kind: 'error', message: 'некорректный формат SSE-чанка' };
  }

  return { kind: 'chunk', chunk: chunk.data };
}

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

    const body = this.buildChatBody(request, false);

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

  /**
   * Стриминговый ответ GigaChat: текст отдаётся дельтами SSE, финальное
   * сообщение (с `usage` и `tool_calls`) — возвращаемое значение генератора.
   * Ошибки валидации/провайдера пробрасываются: `LlmService` уйдёт в
   * нестриминговый fallback, если клиент ещё не получил ни одной дельты.
   */
  async *chatStream(
    request: NativeChatRequest,
  ): AsyncGenerator<NativeStreamDelta, AIMessage, void> {
    if (!this.isConfigured()) {
      throw new Error(
        'GigaChat не настроен: отсутствуют GIGACHAT_CLIENT_ID/GIGACHAT_CLIENT_SECRET',
      );
    }

    const stream = await this.openChatStream(this.buildChatBody(request, true));
    const accumulated: StreamAccumulator = {
      content: '',
      functionName: '',
      functionArguments: '',
    };
    let buffer = '';
    let idleTimer: NodeJS.Timeout | undefined;
    let finished = false;

    const resetIdleTimer = (): void => {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
      }

      idleTimer = setTimeout(() => {
        stream.destroy(new Error('GigaChat: таймаут стриминга'));
      }, GIGACHAT_STREAM_IDLE_TIMEOUT_MS);
      // Таймер не должен держать event loop.
      idleTimer.unref();
    };

    const consumePayload = (payload: string): string => {
      const parsed = parseGigaChatStreamPayload(payload);

      if (parsed.kind === 'error') {
        throw new Error(`GigaChat: ошибка стриминга: ${parsed.message}`);
      }

      if (parsed.chunk.usage !== undefined) {
        accumulated.usage = parsed.chunk.usage;
      }

      let deltaText = '';

      for (const choice of parsed.chunk.choices ?? []) {
        const delta = choice.delta;

        if (delta === undefined) {
          continue;
        }

        if (delta.function_call?.name !== undefined) {
          accumulated.functionName = delta.function_call.name;
        }

        if (delta.function_call?.arguments !== undefined) {
          accumulated.functionArguments += delta.function_call.arguments;
        }

        if (typeof delta.content === 'string' && delta.content !== '') {
          accumulated.content += delta.content;
          deltaText += delta.content;
        }
      }

      return deltaText;
    };

    try {
      resetIdleTimer();

      for await (const raw of stream as AsyncIterable<unknown>) {
        resetIdleTimer();
        buffer +=
          typeof raw === 'string'
            ? raw
            : Buffer.isBuffer(raw) || raw instanceof Uint8Array
              ? Buffer.from(raw as Uint8Array).toString('utf8')
              : '';

        let newline = buffer.indexOf('\n');

        while (newline >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, '');
          buffer = buffer.slice(newline + 1);

          if (line.startsWith('data:')) {
            const payload = line.slice('data:'.length).trim();

            if (payload === '[DONE]') {
              finished = true;
              break;
            }

            const deltaText = consumePayload(payload);

            if (deltaText !== '') {
              yield { type: 'delta', text: deltaText };
            }
          }

          newline = buffer.indexOf('\n');
        }

        if (finished) {
          break;
        }
      }

      // Провайдер может не завершить последнюю строку переводом строки.
      if (!finished && buffer.trim() !== '') {
        const line = buffer.trim();

        if (line.startsWith('data:')) {
          const payload = line.slice('data:'.length).trim();

          if (payload !== '[DONE]') {
            const deltaText = consumePayload(payload);

            if (deltaText !== '') {
              yield { type: 'delta', text: deltaText };
            }
          }
        }
      }
    } catch (error) {
      this.logger.warn(`GigaChat: стриминг прерван: ${describe(error)}`);
      throw error;
    } finally {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
      }
    }

    return this.buildStreamMessage(accumulated);
  }

  /** Тело запроса к GigaChat; `stream` включает SSE-режим. */
  private buildChatBody(
    request: NativeChatRequest,
    stream: boolean,
  ): Record<string, unknown> {
    const functions = toFunctionSpecs(request.tools);

    return {
      model: this.model,
      temperature: 0.7,
      ...(stream ? { stream: true } : {}),
      messages: toNativeMessages(request.messages, request.systemPrompt),
      ...(functions.length > 0
        ? { functions, function_call: 'auto' as const }
        : {}),
    };
  }

  /** Открывает SSE-стрим; на 401 один раз обновляет OAuth-токен. */
  private async openChatStream(
    body: Record<string, unknown>,
  ): Promise<Readable> {
    const authHeaders = (token: string): Record<string, string> => ({
      Authorization: `Bearer ${token}`,
      Accept: 'text/event-stream',
    });
    const token = await this.getToken();

    try {
      return await this.postStream(body, authHeaders(token));
    } catch (error) {
      if (!(isAxiosError(error) && error.response?.status === 401)) {
        this.logger.error(
          `GigaChat: не удалось открыть стрим: ${describe(error)}`,
        );
        throw error;
      }

      this.logger.warn('GigaChat: токен отклонён, обновляем OAuth-токен');
      this.resetToken();

      try {
        return await this.postStream(body, authHeaders(await this.getToken()));
      } catch (retryError) {
        this.logger.error(
          `GigaChat: не удалось открыть стрим: ${describe(retryError)}`,
        );
        throw retryError;
      }
    }
  }

  private async postStream(
    body: Record<string, unknown>,
    headers: Record<string, string>,
  ): Promise<Readable> {
    const response = await this.chatHttp.post<Readable>('', body, {
      headers,
      responseType: 'stream',
    });

    return response.data;
  }

  /** Собирает финальное сообщение из накопленных SSE-чанков. */
  private buildStreamMessage(accumulated: StreamAccumulator): AIMessage {
    const calls: GigaChatFunctionCall[] =
      accumulated.functionName === ''
        ? []
        : [
            {
              name: accumulated.functionName,
              arguments: accumulated.functionArguments,
            },
          ];
    const collapsed = collapseParallelToolCalls(calls, this.logger);

    return new AIMessage({
      content: accumulated.content,
      tool_calls: collapsed
        .filter((call) => typeof call.name === 'string')
        .map((call) => ({
          name: call.name ?? '',
          args: parseToolArguments(call.arguments),
          id: '',
          type: 'tool_call' as const,
        })),
      usage_metadata: {
        input_tokens: accumulated.usage?.prompt_tokens ?? 0,
        output_tokens: accumulated.usage?.completion_tokens ?? 0,
        total_tokens: accumulated.usage?.total_tokens ?? 0,
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
