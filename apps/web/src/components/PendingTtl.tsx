import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getPendingTtl } from '../lib/pending-approvals';

/** Как часто пересчитывать оставшееся время; минута точности достаточна. */
const TTL_TICK_MS = 30_000;

/** «Сейчас» с обновлением раз в полминуты, чтобы таймер TTL не врал. */
function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const intervalId = window.setInterval(() => {
      setNow(Date.now());
    }, TTL_TICK_MS);

    return () => window.clearInterval(intervalId);
  }, [enabled]);

  return now;
}

/**
 * Таймер до истечения ожидания `waiting_approval`.
 *
 * Если `expiresAt` нет (старый API) или дата некорректна — ничего не
 * рендерится, остальной интерфейс не меняется.
 */
export function PendingTtl({
  expiresAt,
  className = '',
}: {
  expiresAt: string | undefined;
  className?: string;
}) {
  const { t } = useTranslation();
  const now = useNow(expiresAt !== undefined);
  const ttl = getPendingTtl(expiresAt, now);

  if (ttl === null) {
    return null;
  }

  const label =
    ttl.kind === 'expired'
      ? t('office.pending.expired')
      : ttl.kind === 'hours'
        ? t('office.pending.expiresInHours', { hours: ttl.value })
        : t('office.pending.expiresInMinutes', { minutes: ttl.value });

  const tone =
    ttl.kind === 'expired'
      ? 'border-error/30 bg-error-container text-on-error-container'
      : 'border-warning/30 bg-warning-container text-on-warning-container';

  return (
    <span
      role="timer"
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${tone} ${className}`}
    >
      <span aria-hidden="true">⏳</span>
      {label}
    </span>
  );
}
