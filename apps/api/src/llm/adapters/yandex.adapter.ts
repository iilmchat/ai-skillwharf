import { AIMessage } from '@langchain/core/messages';
import { Injectable, Logger } from '@nestjs/common';
import axios, { isAxiosError, type AxiosInstance } from 'axios';
import {
  parseToolArguments,
  toFunctionSpecs,
  toNativeMessages,
  type NativeChatRequest,
  type NativeProviderAdapter,
} from './types.js';

/** Эндпоинт YandexGPT (Yandex AI Studio). */
export const YANDEX_COMPLETION_URL =
  'https://llm.api.cloud.yandex.net/foundationModels/v1/completion';

/** Префикс URI модели YandexGPT. */
export const YANDEX_MODEL_URI_PREFIX = 'gpt://';

/**
 * Собирает `modelUri`: если в маршруте уже лежит полный URI — используем
 * его, иначе подставляем каталог из `YANDEX_FOLDER_ID`.
 */
export function buildYandexModelUri(
  modelName: string,
  folderId = process.env.YANDEX_FOLDER_ID ?? '',
): string {
  const trimmed = modelName.trim();

  if (trimmed.startsWith(YANDEX_MODEL_URI_PREFIX)) {
    return trimmed;
  }

  if (folderId.trim() === '') {
    throw new Error(
      'Для YandexGPT нужен YANDEX_FOLDER_ID или полный modelUri (gpt://<folder>/<model>)',
    );
  }

  return `${YANDEX_MODEL_URI_PREFIX}${folderId.trim()}/${trimmed}`;
}

/** Ответ YandexGPT (используемые поля). */
interface YandexCompletionResponse {
  result?: {
    alternatives?: {
      message?: {
        role?: string;
        text?: string;
        toolCallList?: {
          functionCall?: { name?: string; arguments?: unknown };
        }[];
      };
    }[];
    usage?: {
      inputTextTokens?: string;
      completionTokens?: string;
      totalTokens?: string;
    };
  };
}

@Injectable()
export class YandexAdapter implements NativeProviderAdapter {
  readonly provider = 'YandexGPT';
  private readonly logger = new Logger(YandexAdapter.name);
  private readonly http: AxiosInstance;
  private readonly modelUri: string;
  private readonly iamToken: string;

  constructor(
    options: {
      modelUri?: string;
      modelName?: string;
      folderId?: string;
      iamToken?: string;
      http?: AxiosInstance;
    } = {},
  ) {
    this.modelUri =
      options.modelUri ??
      buildYandexModelUri(
        options.modelName ?? 'yandexgpt-lite',
        options.folderId ?? process.env.YANDEX_FOLDER_ID ?? '',
      );
    this.iamToken = options.iamToken ?? process.env.YANDEX_IAM_TOKEN ?? '';
    this.http =
      options.http ??
      axios.create({ baseURL: YANDEX_COMPLETION_URL, timeout: 60_000 });
  }

  /** Задан ли IAM-токен. */
  isConfigured(): boolean {
    return this.iamToken !== '';
  }

  async chat(request: NativeChatRequest): Promise<AIMessage> {
    if (!this.isConfigured()) {
      throw new Error('YandexGPT не настроен: отсутствует YANDEX_IAM_TOKEN');
    }

    const functions = toFunctionSpecs(request.tools);
    const body = {
      modelUri: this.modelUri,
      completionOptions: {
        stream: false,
        temperature: 0.7,
        maxTokens: 2000,
      },
      messages: toNativeMessages(request.messages, request.systemPrompt),
      ...(functions.length > 0
        ? { tools: functions.map((fn) => ({ function: fn })) }
        : {}),
    };

    try {
      const { data } = await this.http.post<YandexCompletionResponse>(
        '',
        body,
        { headers: { Authorization: `Bearer ${this.iamToken}` } },
      );
      const message = data.result?.alternatives?.[0]?.message;
      const usage = data.result?.usage;

      return new AIMessage({
        content: message?.text ?? '',
        tool_calls: (message?.toolCallList ?? [])
          .filter((call) => typeof call.functionCall?.name === 'string')
          .map((call) => ({
            name: call.functionCall?.name ?? '',
            args: parseToolArguments(call.functionCall?.arguments),
            id: '',
            type: 'tool_call' as const,
          })),
        usage_metadata: {
          input_tokens: Number(usage?.inputTextTokens ?? 0),
          output_tokens: Number(usage?.completionTokens ?? 0),
          total_tokens: Number(usage?.totalTokens ?? 0),
        },
      });
    } catch (error) {
      this.logger.error(
        `YandexGPT: ошибка запроса к ${this.modelUri}: ${describe(error)}`,
      );
      throw error;
    }
  }
}

function describe(error: unknown): string {
  if (isAxiosError(error)) {
    const status = error.response?.status ?? 0;
    const data = error.response?.data as { message?: string } | undefined;

    return `HTTP ${status}${data?.message ? `: ${data.message}` : ''}`;
  }

  return error instanceof Error ? error.message : String(error);
}
