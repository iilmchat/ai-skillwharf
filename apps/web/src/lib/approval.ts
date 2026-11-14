/**
 * HITL-подсказки для карточки подтверждения.
 *
 * Бэкенд присылает в `GET /api/v1/chat/pending` список инструментов, на
 * которых агент остановился. По нему UI выбирает формулировку кнопки:
 * для `dzen-article` это публикация статьи, для остальных — обычное
 * подтверждение действия.
 */

/** Инструмент `dzen-article`: экспорт статьи в Дзен (Pay-per-Outcome). */
export const DZEN_PUBLISH_TOOL = 'publish_to_dzen';

export type ApprovalActionKind = 'dzen-publish' | 'generic';

/** Вид действия, которое подтверждает пользователь. */
export function resolveApprovalAction(
  tools: readonly string[],
): ApprovalActionKind {
  return tools.includes(DZEN_PUBLISH_TOOL) ? 'dzen-publish' : 'generic';
}

/** Инструменты с понятным названием; остальные показываются как есть. */
const TOOL_LABEL_KEYS: Readonly<Record<string, string>> = {
  [DZEN_PUBLISH_TOOL]: 'chat.approval.tools.publishToDzen',
};

/** Ключ i18n с названием инструмента (`null` — показываем сырое имя). */
export function approvalToolLabelKey(tool: string): string | null {
  return TOOL_LABEL_KEYS[tool] ?? null;
}
