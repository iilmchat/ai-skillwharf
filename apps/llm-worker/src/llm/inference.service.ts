import { Injectable, Logger } from '@nestjs/common';
import {
  AIMessage,
  AIMessageChunk,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { ChatOpenAI } from '@langchain/openai';
import {
  assertOutboundUrlAllowed,
  parseOutboundAllowlist,
} from '@skillwharf/shared';
import type {
  LlmRouteSelection,
  TokenUsage,
} from '../contracts.js';
import { AgentBridgeService } from '../agent/bridge.service.js';
import { InternalApiError } from '../internal-api.client.js';
import { GigaChatAdapter } from './adapters/gigachat.adapter.js';
import type {
  NativeChatRequest,
  NativeProviderAdapter,
} from './adapters/types.js';
import { YandexAdapter } from './adapters/yandex.adapter.js';
import {
  isNativeProviderType,
  normalizeProviderType,
} from './provider-type.js';
import {
  estimateMessagesTokens,
  estimateUsageFromMessages,
} from './token-estimator.js';

/** Событие стрима модели: дельта текста или финальное сообщение. */
export type InferenceChunk =
  | { type: 'delta'; text: string }
  | { type: 'message'; message: AIMessage };

/** Метаданные вызова для учёта и OTel-атрибутов. */
export interface InferenceOptions {
  userId: string;
  agentId?: string;
  skillId?: string;
}

/** Ответ, который worker отдаёт в граф. */
export interface InferenceResult {
  message: AIMessage;
  route: LlmRouteSelection | null;
}

/** Ошибка исчерпания fallback-цепочки маршрутов. */
export class LlmUnavailableError extends Error {
  readonly statusCode = 502;
  readonly code = 'errors.llm_unavailable';

  constructor(message = 'Все LLM-провайдеры недоступны') {
    super(message);
    this.name = 'LlmUnavailableError';
  }
}

type LlmExecutor =
  | { kind: 'adapter'; adapter: NativeProviderAdapter }
  | { kind: 'client'; client: ChatOpenAI };

interface LlmAttempt {
  route: LlmRouteSelection | undefined;
  executor: LlmExecutor;
}

interface StreamAttemptState {
  emittedDelta: boolean;
  partialUsage: AIMessage['usage_metadata'];
}

/**
 * Inference-часть LLM, перенесённая из API.
 *
 * Здесь нет Prisma, Ledger и нотификаций: бюджет резервируется и сверяется
 * через внутренний API, а деньги списываются в Gateway. Worker отвечает
 * только за транспорт провайдера, fallback по маршрутам и стриминг.
 */
@Injectable()
export class LlmInferenceService {
  private readonly logger = new Logger(LlmInferenceService.name);
  private readonly client: ChatOpenAI | null;
  private readonly outboundAllowlist = parseOutboundAllowlist(
    process.env.OUTBOUND_ALLOWLIST,
  );

  constructor(private readonly bridge: AgentBridgeService) {
    const baseURL = process.env.LLM_BASE_URL;
    const model = process.env.LLM_MODEL;

    if (!baseURL || !model) {
      this.client = null;
      this.logger.warn(
        'LLM не настроен (LLM_BASE_URL/LLM_MODEL) — используется эхо-заглушка',
      );

      return;
    }

    try {
      this.assertOutboundAllowed(baseURL);
    } catch (error) {
      this.client = null;
      this.logger.error(
        `LLM_BASE_URL заблокирован egress-политикой: ${describeError(error)}`,
      );

      return;
    }

    this.client = new ChatOpenAI({
      model,
      apiKey: process.env.LLM_API_KEY || 'not-needed',
      configuration: { baseURL },
      temperature: 0.7,
    });
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  /**
   * Стриминговый вызов с fallback-цепочкой.
   *
   * Резерв дневного бюджета берётся один раз до первой попытки и
   * возвращается/сверяется ровно один раз. После первой дельты повтор на
   * другом маршруте невозможен: пользователь увидел бы текст дважды.
   */
  async *stream(
    messages: BaseMessage[],
    tools: StructuredToolInterface[],
    routes: LlmRouteSelection[],
    systemPrompt: string,
    options: InferenceOptions,
  ): AsyncGenerator<InferenceChunk, InferenceResult, unknown> {
    const attempts = this.buildAttempts(routes);

    if (attempts.length === 0) {
      const text = this.echoText(messages);
      const message = new AIMessage(text);

      yield { type: 'delta', text };
      yield { type: 'message', message };

      return { message, route: null };
    }

    const reservation = await this.reserve(
      options.userId,
      estimateMessagesTokens(messages, systemPrompt),
    );
    const taskType = routes[0]?.taskType ?? 'chat';

    for (let index = 0; index < attempts.length; index++) {
      const attempt = attempts[index]!;
      const state: StreamAttemptState = {
        emittedDelta: false,
        partialUsage: undefined,
      };
      let message: AIMessage;

      try {
        message = yield* this.streamAttempt(
          attempt,
          messages,
          tools,
          systemPrompt,
          state,
        );
      } catch (error) {
        if (totalTokens(state.partialUsage) > 0) {
          await this.settle(
            options,
            attempt.route,
            reservation.reserved,
            state.partialUsage,
            false,
          );
          throw error;
        }

        if (state.emittedDelta) {
          await this.refund(options.userId, reservation.reserved);
          throw error;
        }

        const next = attempts[index + 1];

        if (next === undefined || !isRetriableLlmError(error)) {
          await this.refund(options.userId, reservation.reserved);

          // 502 и для одиночного маршрута или env-fallback: клиенту нужен
          // машиночитаемый `errors.llm_unavailable`, а не сырая ошибка
          // провайдера (KI-041). Неретраибельные 400/401/403 по-прежнему
          // пробрасываются как есть.
          if (isRetriableLlmError(error)) {
            throw new LlmUnavailableError();
          }

          throw error;
        }

        this.logRouterFallback(attempt.route, next.route, error, taskType);
        continue;
      }

      const { usage, estimated } = this.resolveUsage(
        messages,
        systemPrompt,
        messageContentToText(message.content),
        message.usage_metadata,
      );

      await this.settle(options, attempt.route, reservation.reserved, usage, estimated);

      if (
        !state.emittedDelta &&
        typeof message.content === 'string' &&
        message.content !== ''
      ) {
        yield { type: 'delta', text: message.content };
      }

      yield { type: 'message', message };

      return { message, route: attempt.route ?? null };
    }

    await this.refund(options.userId, reservation.reserved);
    throw new LlmUnavailableError();
  }

  private async reserve(
    userId: string,
    estimatedPromptTokens: number,
  ): Promise<{ reserved: number; tracked: boolean }> {
    try {
      return await this.bridge.reserveBudget(userId, estimatedPromptTokens);
    } catch (error) {
      // Бизнес-отказы API (лимит токенов, недостаточно средств) нельзя
      // проглатывать: иначе Budget Guard перестаёт работать. Деградируем
      // только при недоступности внутреннего API.
      if (error instanceof InternalApiError && error.statusCode < 500) {
        throw error;
      }

      this.logger.warn(
        `Budget reserve недоступен: ${describeError(error)}; вызов продолжается без учёта`,
      );

      return { reserved: 0, tracked: false };
    }
  }

  private async settle(
    options: InferenceOptions,
    route: LlmRouteSelection | undefined,
    reserved: number,
    usage: AIMessage['usage_metadata'],
    estimated: boolean,
  ): Promise<void> {
    try {
      await this.bridge.settleBudget({
        userId: options.userId,
        reserved,
        usage: toTokenUsage(usage),
        estimated,
        route: route ?? null,
        ...(options.agentId === undefined ? {} : { agentId: options.agentId }),
        ...(options.skillId === undefined ? {} : { skillId: options.skillId }),
      });
    } catch (error) {
      // Ответ модели уже получен: ошибка учёта не должна ломать стрим.
      this.logger.warn(`Budget settle недоступен: ${describeError(error)}`);
    }
  }

  private async refund(userId: string, reserved: number): Promise<void> {
    try {
      await this.bridge.refundBudget(userId, reserved);
    } catch (error) {
      this.logger.warn(`Budget refund недоступен: ${describeError(error)}`);
    }
  }

  private async *streamAttempt(
    attempt: LlmAttempt,
    messages: BaseMessage[],
    tools: StructuredToolInterface[],
    systemPrompt: string,
    state: StreamAttemptState,
  ): AsyncGenerator<InferenceChunk, AIMessage, unknown> {
    const { executor } = attempt;

    if (executor.kind === 'adapter') {
      return yield* this.streamAdapterAttempt(
        executor.adapter,
        { messages, tools, systemPrompt },
        state,
      );
    }

    return yield* this.streamClientAttempt(
      executor.client,
      messages,
      tools,
      systemPrompt,
      state,
    );
  }

  private async *streamAdapterAttempt(
    adapter: NativeProviderAdapter,
    request: NativeChatRequest,
    state: StreamAttemptState,
  ): AsyncGenerator<InferenceChunk, AIMessage, unknown> {
    if (adapter.chatStream === undefined) {
      return await adapter.chat(request);
    }

    try {
      const stream = adapter.chatStream(request);
      let step = await stream.next();

      while (!step.done) {
        if (step.value.type === 'delta' && step.value.text !== '') {
          state.emittedDelta = true;
          yield { type: 'delta', text: step.value.text };
        }

        step = await stream.next();
      }

      return step.value;
    } catch (error) {
      if (state.emittedDelta) {
        throw error;
      }

      this.logger.warn(
        `LLM-адаптер ${adapter.provider}: стриминг недоступен (${describeError(error)}), fallback на обычный режим`,
      );

      return await adapter.chat(request);
    }
  }

  private async *streamClientAttempt(
    client: ChatOpenAI,
    messages: BaseMessage[],
    tools: StructuredToolInterface[],
    systemPrompt: string,
    state: StreamAttemptState,
  ): AsyncGenerator<InferenceChunk, AIMessage, unknown> {
    const model = tools.length > 0 ? client.bindTools(tools) : client;
    let accumulated: AIMessageChunk | undefined;

    try {
      for await (const chunk of await model.stream(
        withLanguageInstruction(messages, systemPrompt),
      )) {
        accumulated = accumulated ? accumulated.concat(chunk) : chunk;

        if (chunk.text) {
          state.emittedDelta = true;
          yield { type: 'delta', text: chunk.text };
        }
      }
    } catch (error) {
      state.partialUsage = accumulated?.usage_metadata;
      throw error;
    }

    return accumulated
      ? new AIMessage({
          content: accumulated.content,
          tool_calls: accumulated.tool_calls,
          invalid_tool_calls: accumulated.invalid_tool_calls,
          usage_metadata: accumulated.usage_metadata,
        })
      : new AIMessage('');
  }

  private buildAttempts(routes: LlmRouteSelection[]): LlmAttempt[] {
    if (routes.length === 0) {
      const executor = this.resolveExecutor(undefined);

      return executor === null ? [] : [{ route: undefined, executor }];
    }

    const attempts: LlmAttempt[] = [];

    for (let index = 0; index < routes.length; index++) {
      const route = routes[index]!;
      let executor: LlmExecutor | null;

      try {
        executor = this.resolveExecutor(route);
      } catch (error) {
        this.logger.warn(
          `Маршрут ${route.name} пропущен: ${describeError(error)}`,
        );
        continue;
      }

      if (executor === null) {
        this.logRouterFallback(
          route,
          routes[index + 1],
          new Error('маршрут не сконфигурирован'),
          route.taskType ?? 'chat',
        );
        continue;
      }

      attempts.push({ route, executor });
    }

    return attempts;
  }

  private resolveExecutor(route?: LlmRouteSelection): LlmExecutor | null {
    const adapter = this.resolveAdapter(route);

    if (adapter !== null) {
      return { kind: 'adapter', adapter };
    }

    const client = this.resolveClient(route);

    return client === null ? null : { kind: 'client', client };
  }

  private resolveAdapter(
    route?: LlmRouteSelection,
  ): NativeProviderAdapter | null {
    if (!route) {
      return null;
    }

    const providerType = normalizeProviderType(route.providerType);

    if (!isNativeProviderType(providerType)) {
      return null;
    }

    if (providerType === 'YandexGPT') {
      const tokenEnvVar = route.apiKeyEnvVar ?? 'YANDEX_IAM_TOKEN';

      return new YandexAdapter({
        modelName: route.modelName,
        iamToken: process.env[tokenEnvVar] ?? process.env.YANDEX_IAM_TOKEN,
      });
    }

    return new GigaChatAdapter({ model: route.modelName });
  }

  private resolveClient(route?: LlmRouteSelection): ChatOpenAI | null {
    if (!route) {
      return this.client;
    }

    const modelName = route.modelName.trim();
    const baseURL = route.baseUrl.trim();

    if (!modelName || !baseURL) {
      return this.client;
    }

    this.assertOutboundAllowed(baseURL);

    const apiKey = route.apiKeyEnvVar
      ? process.env[route.apiKeyEnvVar]
      : process.env.LLM_API_KEY;

    return new ChatOpenAI({
      model: modelName,
      apiKey: apiKey || 'not-needed',
      configuration: { baseURL },
      temperature: 0.7,
    });
  }

  /**
   * Egress-политика worker'а: внешние LLM-эндпоинты только из allowlist.
   * В тестах (NODE_ENV=test) проверка отключена, чтобы моки могли
   * использовать синтетический llm.test.
   */
  private assertOutboundAllowed(rawUrl: string): void {
    if (process.env.NODE_ENV === 'test') {
      return;
    }

    assertOutboundUrlAllowed(rawUrl, this.outboundAllowlist);
  }

  private resolveUsage(
    messages: BaseMessage[],
    systemPrompt: string,
    completionText: string,
    usage: AIMessage['usage_metadata'],
  ): { usage: AIMessage['usage_metadata']; estimated: boolean } {
    if (totalTokens(usage) > 0) {
      return { usage, estimated: false };
    }

    return {
      usage: estimateUsageFromMessages(messages, completionText, systemPrompt),
      estimated: true,
    };
  }

  private logRouterFallback(
    from: LlmRouteSelection | undefined,
    to: LlmRouteSelection | undefined,
    error: unknown,
    taskType: string,
  ): void {
    this.logger.warn(
      JSON.stringify({
        event: 'gen_ai.router.fallback',
        from: from?.name ?? 'env',
        to: to?.name ?? 'env',
        reason: describeError(error),
        taskType: from?.taskType ?? to?.taskType ?? taskType,
      }),
    );
  }

  private echoText(messages: BaseMessage[]): string {
    const lastUserMessage = [...messages]
      .reverse()
      .find((message) => message instanceof HumanMessage);

    return `LLM not configured: ${messageContentToText(lastUserMessage?.content ?? '')}`;
  }
}

export function withLanguageInstruction(
  messages: BaseMessage[],
  systemPrompt: string,
): BaseMessage[] {
  return [new SystemMessage(systemPrompt), ...messages];
}

export function messageContentToText(content: BaseMessage['content']): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }

      if (part && typeof part === 'object' && 'text' in part) {
        const text: unknown = (part as { text?: unknown }).text;

        return typeof text === 'string' ? text : '';
      }

      return '';
    })
    .join('');
}

function toTokenUsage(usage: AIMessage['usage_metadata']): TokenUsage {
  const input = Math.max(0, usage?.input_tokens ?? 0);
  const output = Math.max(0, usage?.output_tokens ?? 0);

  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: Math.max(
      0,
      usage?.total_tokens ?? input + output,
    ),
  };
}

function totalTokens(usage: AIMessage['usage_metadata']): number {
  const tokens =
    usage?.total_tokens ??
    (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0);

  return Number.isFinite(tokens) ? Math.max(0, tokens) : 0;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.name === 'Error'
      ? error.message
      : `${error.name}: ${error.message}`;
  }

  return String(error);
}

/** Признак временной ошибки провайдера: 429/5xx, таймаут, обрыв сети. */
export function isRetriableLlmError(error: unknown): boolean {
  const status = httpStatusOf(error);

  if (status !== null) {
    return status === 429 || status >= 500;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  if (
    error.name === 'AbortError' ||
    error.name === 'TimeoutError' ||
    error.name === 'APIConnectionTimeoutError' ||
    error.name === 'APIConnectionError'
  ) {
    return true;
  }

  return RETRIABLE_ERROR_PATTERN.test(error.message);
}

function httpStatusOf(error: unknown): number | null {
  if (error === null || typeof error !== 'object') {
    return null;
  }

  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    response?: { status?: unknown };
  };
  const raw =
    candidate.status ?? candidate.statusCode ?? candidate.response?.status;
  const parsed =
    typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10);

  return Number.isInteger(parsed) && parsed >= 100 && parsed <= 599
    ? parsed
    : null;
}

const RETRIABLE_ERROR_PATTERN =
  /(?:^|\D)(?:429|5\d\d)(?:\D|$)|timeout|timed out|таймаут|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|connection reset|network error|fetch failed/i;
