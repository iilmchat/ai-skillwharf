import { z } from 'zod';

export const corpMessengerProviderSchema = z.enum([
  'vk_teams',
  'pachca',
  'yandex_messenger',
]);
export type CorpMessengerProvider = z.infer<typeof corpMessengerProviderSchema>;

/** Решение HITL из callback-кнопки мессенджера. */
export interface CorpHitlDecision {
  readonly action: 'approve' | 'reject';
  readonly runId: string;
}

export const corpHitlDataSchema = z
  .object({ action: z.enum(['approve', 'reject']), runId: z.string().min(1).max(64) })
  .strict();

/** Парсит callback_data формата `hitl:<action>:<runId>`. */
export function parseCorpHitlData(
  data: string | undefined,
): CorpHitlDecision | null {
  if (data === undefined) {
    return null;
  }

  const parts = data.split(':');

  if (parts.length !== 3 || parts[0] !== 'hitl') {
    return null;
  }

  const parsed = corpHitlDataSchema.safeParse({
    action: parts[1],
    runId: parts[2],
  });

  return parsed.success ? parsed.data : null;
}

/** Нормализованное входящее сообщение любого провайдера. */
export interface CorpIncomingMessage {
  readonly chatId: string;
  readonly text: string;
  readonly hitl?: CorpHitlDecision;
}

/** Параметры исходящего сообщения. */
export interface CorpSendInput {
  readonly baseUrl: string | null;
  readonly token: string;
  readonly chatId: string;
  readonly text: string;
  /** Если задан — к сообщению прикрепляются кнопки одобрения/отклонения. */
  readonly hitlRunId?: string;
}

/**
 * Единый контракт адаптера корпоративного мессенджера (OMNI-40.1).
 * Все входящие данные и ответы провайдеров валидируются Zod внутри адаптера.
 */
export interface ICorpMessengerAdapter {
  readonly provider: CorpMessengerProvider;
  parseIncomingWebhook(
    payload: unknown,
    headers: Readonly<Record<string, string>>,
  ): CorpIncomingMessage | null;
  sendTextMessage(input: CorpSendInput): Promise<void>;
}

/** Общие кнопки HITL в формате `hitl:<action>:<runId>`. */
export function hitlButtons(runId: string): readonly {
  readonly text: string;
  readonly callbackData: string;
}[] {
  return [
    { text: '✅ Одобрить', callbackData: `hitl:approve:${runId}` },
    { text: '❌ Отклонить', callbackData: `hitl:reject:${runId}` },
  ];
}

/** Базовый URL с дефолтом провайдера. */
export function resolveBaseUrl(baseUrl: string | null, fallback: string): string {
  const value = baseUrl?.trim() ?? '';

  return (value === '' ? fallback : value).replace(/\/+$/, '');
}

/** Проверка HTTP-ответа провайдера; детали ошибки не логируются. */
export async function assertProviderResponse(
  response: Response,
  provider: CorpMessengerProvider,
): Promise<void> {
  if (!response.ok) {
    throw new Error(`${provider}: HTTP ${response.status}`);
  }
}
