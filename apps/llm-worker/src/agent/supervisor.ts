import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { BaseMessage } from '@langchain/core/messages';
import { AIMessage } from '@langchain/core/messages';
import type { ChatStreamEvent } from './graph.js';
import type { AgentRole } from '../contracts.js';

/**
 * Супервизор мультиагентного графа (GRAPH-30.1, Sprint 30).
 *
 * В режиме `supervisor` граф проходит по списку профильных ролей, публикуя
 * событие `agent_handoff` для анимации AI-Офиса. Число передач ограничено,
 * а `traceId` единый для всех шагов графа (OTel/Tempo).
 */

export const DEFAULT_MAX_HANDOFFS = 4;

export const maxHandoffsFromEnv = (
  raw: string | undefined = process.env.MULTI_AGENT_MAX_HANDOFFS,
): number => {
  const parsed = Number.parseInt(raw ?? '', 10);

  return Number.isInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MAX_HANDOFFS;
};

/** Детерминированный выбор следующей роли по содержимому последнего сообщения. */
export function selectNextRole(
  roles: readonly AgentRole[],
  lastMessage: BaseMessage | undefined,
  fallback: AgentRole = 'researcher',
): AgentRole {
  if (roles.length === 0) {
    return fallback;
  }

  const content =
    lastMessage === undefined
      ? ''
      : typeof lastMessage.content === 'string'
        ? lastMessage.content
        : JSON.stringify(lastMessage.content);
  const tools =
    lastMessage instanceof AIMessage
      ? JSON.stringify(lastMessage.tool_calls ?? [])
      : '';
  const text = `${content} ${tools}`;
  const lower = text.toLowerCase();
  const match = (needles: readonly string[]): boolean =>
    needles.some((needle) => lower.includes(needle));

  if (match(['draft', 'статья', 'статью', 'контент', 'текст', 'write_docx']) && roles.includes('drafter')) {
    return 'drafter';
  }
  if (match(['review', 'провер', 'audit', 'критик']) && roles.includes('reviewer')) {
    return 'reviewer';
  }
  if (match(['аналит', 'отчет', 'отчёт', 'report', 'finance', 'метрик']) && roles.includes('analyst')) {
    return 'analyst';
  }
  if (match(['заказ', 'отгруз', 'order', 'demand', 'execute', ' tools']) && roles.includes('operator')) {
    return 'operator';
  }
  if (roles.includes('researcher')) {
    return 'researcher';
  }

  return roles[0]!;
}

export interface HandoffEventInput {
  readonly conversationId: string;
  readonly traceId: string;
  readonly fromRole: AgentRole | 'supervisor';
  readonly toRole: AgentRole;
  readonly reason: string;
}

/** Событие смены роли для AI-Офиса и трассировки. */
export function handoffEvent(input: HandoffEventInput): ChatStreamEvent {
  return {
    type: 'agent_handoff',
    conversationId: input.conversationId,
    traceId: input.traceId,
    fromRole: input.fromRole,
    toRole: input.toRole,
    reason: z.string().max(256).parse(input.reason),
  };
}

/** Новый сквозной traceId запуска (если клиент не передал свой). */
export function freshTraceId(existing?: string): string {
  const trimmed = existing?.trim() ?? '';

  return trimmed === '' ? randomUUID() : trimmed;
}
