import type { AIMessage, BaseMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { z } from 'zod';

/** Запрос к нативному адаптеру российского LLM-провайдера. */
export interface NativeChatRequest {
  messages: BaseMessage[];
  tools: StructuredToolInterface[];
  systemPrompt: string;
}

/**
 * Адаптер провайдера с собственным протоколом (YandexGPT, GigaChat).
 * Возвращает `AIMessage` в формате LangChain, чтобы граф агента не знал,
 * какой провайдер отвечает.
 */
export interface NativeProviderAdapter {
  /** Человекочитаемое имя провайдера для логов. */
  readonly provider: string;

  chat(request: NativeChatRequest): Promise<AIMessage>;
}

/** Роль сообщения в формате российских провайдеров. */
export type NativeRole = 'system' | 'user' | 'assistant';

/** Сообщение в формате российских провайдеров. */
export interface NativeMessage {
  role: NativeRole;
  text: string;
}

/**
 * Приводит историю LangChain к простому виду `role/text`. Результаты
 * инструментов отправляются как `user`-сообщения: у YandexGPT и GigaChat
 * нет единого формата function-сообщений, а такой прокси-вариант работает
 * у обоих провайдеров.
 */
export function toNativeMessages(
  messages: BaseMessage[],
  systemPrompt: string,
): NativeMessage[] {
  const result: NativeMessage[] = [];

  if (systemPrompt.trim() !== '') {
    result.push({ role: 'system', text: systemPrompt });
  }

  for (const message of messages) {
    const text = textOf(message.content);

    if (text === '') {
      continue;
    }

    result.push({ role: roleOf(message), text });
  }

  return result;
}

function roleOf(message: BaseMessage): NativeRole {
  switch (message.getType()) {
    case 'system':
      return 'system';
    case 'ai':
      return 'assistant';
    default:
      return 'user';
  }
}

function textOf(content: unknown): string {
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
        const text = (part as { text?: unknown }).text;

        return typeof text === 'string' ? text : '';
      }

      return '';
    })
    .join('');
}

/** Описание функции в формате, который принимают YandexGPT и GigaChat. */
export interface NativeFunctionSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Преобразует zod-схему инструмента в JSON Schema. Провайдеры не принимают
 * `$schema`, поэтому служебное поле убираем.
 */
export function toFunctionSpecs(
  tools: StructuredToolInterface[],
): NativeFunctionSpec[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? '',
    parameters: toJsonSchema((tool as { schema?: unknown }).schema),
  }));
}

function toJsonSchema(schema: unknown): Record<string, unknown> {
  if (schema instanceof z.ZodType) {
    const json = z.toJSONSchema(schema, { io: 'input' }) as Record<
      string,
      unknown
    >;

    delete json.$schema;

    return json;
  }

  return { type: 'object', properties: {} };
}

/** Аргументы инструмента: провайдеры присылают объект или JSON-строка. */
export function parseToolArguments(args: unknown): Record<string, unknown> {
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }

  if (typeof args === 'string' && args.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(args);

      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Некорректный JSON от провайдера — отдаём пустые аргументы, чтобы
      // инструмент вернул понятную ошибку валидации.
    }
  }

  return {};
}
