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

/** Эндпоинт обмена OAuth-токена на IAM-токен. */
export const YANDEX_IAM_URL = 'https://iam.api.cloud.yandex.net/iam/v1/tokens';

/** Префикс URI модели YandexGPT. */
export const YANDEX_MODEL_URI_PREFIX = 'gpt://';

/** IAM-токен живёт 12 часов; кэшируем 11, чтобы не отправить протухший. */
export const YANDEX_IAM_TOKEN_TTL_MS = 11 * 60 * 60 * 1000;

/** Запас: токен обновляется за минуту до истечения кэша. */
export const YANDEX_IAM_TOKEN_SKEW_MS = 60 * 1000;

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

/** Ответ эндпоинта обмена OAuth-токена на IAM. */
interface YandexIamTokenResponse {
  iamToken?: string;
  expiresAt?: string;
}

interface CachedIamToken {
  token: string;
  /** Момент (ms), после которого кэш считается протухшим. */
  expiresAt: number;
  /** OAuth-токен, которым получен IAM-токен: кэш не переиспользуется при смене ключа. */
  oauthToken: string;
}

/**
 * Кэш IAM-токена общий на процесс: `LlmService` создаёт адаптер на каждый
 * запрос, поэтому хранить кэш в поле экземпляра бессмысленно.
 */
let cachedIamToken: CachedIamToken | null = null;

/** Сбрасывает кэш IAM-токена (после 401 и в тестах). */
export function resetYandexIamTokenCache(): void {
  cachedIamToken = null;
}

@Injectable()
export class YandexAdapter implements NativeProviderAdapter {
  readonly provider = 'YandexGPT';
  private readonly logger = new Logger(YandexAdapter.name);
  private readonly http: AxiosInstance;
  private readonly iamHttp: AxiosInstance;
  private readonly modelUri: string;
  private readonly iamToken: string;
  private readonly oauthToken: string;
  private readonly folderId: string;

  constructor(
    options: {
      modelUri?: string;
      modelName?: string;
      folderId?: string;
      iamToken?: string;
      oauthToken?: string;
      http?: AxiosInstance;
      iamHttp?: AxiosInstance;
    } = {},
  ) {
    this.folderId = options.folderId ?? process.env.YANDEX_FOLDER_ID ?? '';
    this.modelUri =
      options.modelUri ??
      buildYandexModelUri(options.modelName ?? 'yandexgpt-lite', this.folderId);
    this.iamToken = options.iamToken ?? process.env.YANDEX_IAM_TOKEN ?? '';
    this.oauthToken =
      options.oauthToken ?? process.env.YANDEX_OAUTH_TOKEN ?? '';
    this.http =
      options.http ??
      axios.create({ baseURL: YANDEX_COMPLETION_URL, timeout: 60_000 });
    this.iamHttp =
      options.iamHttp ??
      axios.create({ baseURL: YANDEX_IAM_URL, timeout: 15_000 });
  }

  /** Задан ли статический IAM-токен или пара OAuth-токен + каталог. */
  isConfigured(): boolean {
    return this.hasOauthCredentials() || this.iamToken !== '';
  }

  /**
   * Возвращает IAM-токен для вызовов LLM. Если заданы `YANDEX_OAUTH_TOKEN`
   * и `YANDEX_FOLDER_ID`, обменивает OAuth-токен на IAM и кэширует его на
   * 11 часов; иначе использует статический `YANDEX_IAM_TOKEN`.
   */
  async getIamToken(): Promise<string> {
    if (!this.hasOauthCredentials()) {
      if (this.iamToken !== '') {
        return this.iamToken;
      }

      throw new Error(
        'YandexGPT не настроен: нужен YANDEX_IAM_TOKEN или пара YANDEX_OAUTH_TOKEN + YANDEX_FOLDER_ID',
      );
    }

    const now = Date.now();

    if (
      cachedIamToken !== null &&
      cachedIamToken.oauthToken === this.oauthToken &&
      cachedIamToken.expiresAt - YANDEX_IAM_TOKEN_SKEW_MS > now
    ) {
      return cachedIamToken.token;
    }

    const { data } = await this.iamHttp.post<YandexIamTokenResponse>('', {
      yandexPassportOauthToken: this.oauthToken,
    });

    if (typeof data.iamToken !== 'string' || data.iamToken === '') {
      throw new Error('YandexGPT: IAM-эндпоинт не вернул iamToken');
    }

    cachedIamToken = {
      token: data.iamToken,
      expiresAt: now + YANDEX_IAM_TOKEN_TTL_MS,
      oauthToken: this.oauthToken,
    };

    return data.iamToken;
  }

  async chat(request: NativeChatRequest): Promise<AIMessage> {
    if (!this.isConfigured()) {
      throw new Error(
        'YandexGPT не настроен: нужен YANDEX_IAM_TOKEN или пара YANDEX_OAUTH_TOKEN + YANDEX_FOLDER_ID',
      );
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

    let data = await this.send(body);

    if (data === null) {
      // IAM-токен мог истечь или быть отозван раньше срока — обновляем и
      // повторяем запрос один раз.
      resetYandexIamTokenCache();
      data = await this.send(body);
    }

    if (data === null) {
      throw new Error('YandexGPT: API отклонил IAM-токен (HTTP 401)');
    }

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
  }

  private hasOauthCredentials(): boolean {
    return this.oauthToken !== '' && this.folderId.trim() !== '';
  }

  /** Отправляет completion-запрос; на 401 возвращает `null` для повтора. */
  private async send(body: unknown): Promise<YandexCompletionResponse | null> {
    const token = await this.getIamToken();

    try {
      const { data } = await this.http.post<YandexCompletionResponse>(
        '',
        body,
        { headers: { Authorization: `Bearer ${token}` } },
      );

      return data;
    } catch (error) {
      if (isAxiosError(error) && error.response?.status === 401) {
        this.logger.warn('YandexGPT: IAM-токен отклонён, обновляем токен');

        return null;
      }

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
