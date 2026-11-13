import type { BaseMessage } from '@langchain/core/messages';
import { getEncoding, type Tiktoken } from 'js-tiktoken';

/**
 * Служебные токены на одно сообщение: роль, разделители и обвязка формата
 * чата. Точное значение зависит от провайдера, для оценки достаточно
 * небольшой константы.
 */
export const MESSAGE_OVERHEAD_TOKENS = 4;

/** Эвристика без токенизатора: в среднем 4 символа на один токен. */
export const HEURISTIC_CHARS_PER_TOKEN = 4;

/** Оценка расхода токенов на вызов: prompt, completion и суммарно. */
export interface EstimatedTokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

/**
 * Ленивый кодировщик `cl100k_base` из js-tiktoken.
 *
 * Почему cl100k_base:
 * - токенизатор GigaChat не опубликован, а у YandexGPT нет доступного
 *   локального словаря, поэтому берём самый близкий открытый BPE-словарь
 *   (семейство GPT-4/3.5); для русского текста он даёт приближение с
 *   погрешностью, достаточной для бюджета;
 * - по `docs/architecture/LLM-Router-Providers.md` у GigaChat одинаковая
 *   цена input и output, поэтому для расхода важна именно сумма токенов,
 *   а не их разбивка;
 * - кодировщик инициализируется лениво: его словарь грузится только при
 *   первом реальном вызове LLM и не замедляет старт приложения.
 *
 * `undefined` — кодировщик ещё не инициализирован, `null` — инициализация
 * не удалась, работаем по эвристике.
 *
 * Схемы инструментов (`tools`) в оценку не входят: их вклад в prompt —
 * небольшая константа, а недостачу сверка резерва дописывает по факту.
 */
let cachedEncoder: Tiktoken | null | undefined;

/** Возвращает кодировщик или `null`, если он недоступен. */
function getTokenEncoder(): Tiktoken | null {
  if (cachedEncoder !== undefined) {
    return cachedEncoder;
  }

  try {
    cachedEncoder = getEncoding('cl100k_base');
  } catch {
    // Словарь не загрузился (нет данные/повреждён пакет): бюджет считаем
    // эвристикой, но приложение не падает.
    cachedEncoder = null;
  }

  return cachedEncoder;
}

/** Эвристическая оценка: 4 символа на токен, минимум 1 токен. */
function estimateTextTokensHeuristically(text: string): number {
  return Math.max(1, Math.ceil(text.length / HEURISTIC_CHARS_PER_TOKEN));
}

/**
 * Оценивает число токенов в тексте. При доступном кодировщике использует
 * `cl100k_base`, иначе — эвристику `chars/4`. Ошибка кодировщика на
 * конкретной строке тоже деградирует до эвристики, а не роняет вызов LLM.
 */
export function estimateTextTokens(text: string): number {
  const normalized = text.trim();

  if (normalized === '') {
    return 0;
  }

  const encoder = getTokenEncoder();

  if (encoder !== null) {
    try {
      return encoder.encode(normalized).length;
    } catch {
      cachedEncoder = null;
    }
  }

  return estimateTextTokensHeuristically(normalized);
}

/** Приводит контент сообщения LangChain (строка или блоки) к строке. */
function messageText(content: BaseMessage['content']): string {
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

/**
 * Оценивает prompt целиком: системный промпт (если передан) и историю
 * сообщений. К каждому сообщению добавляется `MESSAGE_OVERHEAD_TOKENS`
 * на служебную обвязку.
 */
export function estimateMessagesTokens(
  messages: readonly BaseMessage[],
  systemPrompt?: string,
): number {
  let tokens = 0;

  if (systemPrompt !== undefined && systemPrompt.trim() !== '') {
    tokens += estimateTextTokens(systemPrompt) + MESSAGE_OVERHEAD_TOKENS;
  }

  for (const message of messages) {
    tokens +=
      estimateTextTokens(messageText(message.content)) +
      MESSAGE_OVERHEAD_TOKENS;
  }

  return tokens;
}

/**
 * Оценивает полный расход вызова: prompt из отправленных сообщений плюс
 * completion по тексту ответа. Используется, когда провайдер не прислал
 * `usage` (KI-022) и для резерва дневного бюджета (KI-021).
 */
export function estimateUsageFromMessages(
  messages: readonly BaseMessage[],
  completionText: string,
  systemPrompt?: string,
): EstimatedTokenUsage {
  const inputTokens = estimateMessagesTokens(messages, systemPrompt);
  const outputTokens = estimateTextTokens(completionText);

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: inputTokens + outputTokens,
  };
}
