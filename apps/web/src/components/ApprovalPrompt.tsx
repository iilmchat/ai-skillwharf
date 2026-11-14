import { useTranslation } from 'react-i18next';
import { approvalToolLabelKey, resolveApprovalAction } from '../lib/approval';

/**
 * HITL-карточка в чате: агент остановился на действии, требующем
 * подтверждения. Для `dzen-article` кнопка подписана «Одобрить публикацию».
 */
export function ApprovalPrompt({
  reason,
  tools,
  isSubmitting,
  onApprove,
  onReject,
}: {
  reason: 'approval' | 'payment';
  tools: readonly string[];
  isSubmitting: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const { t } = useTranslation();
  const isPayment = reason === 'payment';
  const isDzenPublish = resolveApprovalAction(tools) === 'dzen-publish';
  const approveLabel = isDzenPublish
    ? t('chat.approval.approveDzen')
    : t('chat.approval.approve');
  const toolLabels = tools.map((tool) => {
    const key = approvalToolLabelKey(tool);

    return key === null ? tool : t(key);
  });

  return (
    <section
      aria-labelledby="chat-approval-title"
      className="rounded-2xl border border-warning/40 bg-warning-container/40 p-4"
    >
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="text-xl leading-none">
          {isPayment ? '💳' : '✋'}
        </span>
        <div className="min-w-0">
          <h2
            id="chat-approval-title"
            className="text-sm font-semibold text-on-warning-container"
          >
            {isPayment
              ? t('chat.approval.paymentTitle')
              : t('chat.approval.title')}
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-on-warning-container">
            {isPayment
              ? t('chat.approval.paymentBody')
              : t('chat.approval.body')}
          </p>
          {toolLabels.length > 0 && (
            <p className="mt-2 break-words text-[11px] text-on-warning-container/80">
              {t('chat.approval.toolsLabel')}: {toolLabels.join(', ')}
            </p>
          )}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onApprove}
          disabled={isSubmitting}
          aria-busy={isSubmitting}
          className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-on-primary shadow-lg shadow-primary/25 transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none"
        >
          <span aria-hidden="true">✋</span>
          {isSubmitting ? t('chat.approval.submitting') : approveLabel}
        </button>
        <button
          type="button"
          onClick={onReject}
          disabled={isSubmitting}
          className="rounded-xl border border-outline px-4 py-2 text-sm font-semibold text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t('chat.approval.reject')}
        </button>
      </div>
    </section>
  );
}
