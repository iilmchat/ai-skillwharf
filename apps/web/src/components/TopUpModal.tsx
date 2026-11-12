import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { balanceQueryKey } from '../hooks/useBalance';
import {
  getBillingErrorMessage,
  topUpBalance,
  type TopUpPayload,
} from '../lib/billing';
import { CURRENCY_SYMBOL, formatMoney } from '../lib/money';

const PRESETS = [100, 500, 1000] as const;
const DEFAULT_AMOUNT = '500';

interface TopUpModalProps {
  open: boolean;
  onClose: () => void;
  userId: string;
  balance: string | undefined;
}

function parseAmount(value: string): number | null {
  const normalized = value.replace(',', '.').trim();

  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    return null;
  }

  const amount = Number(normalized);

  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

export function TopUpModal({
  open,
  onClose,
  userId,
  balance,
}: TopUpModalProps) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const amountInputRef = useRef<HTMLInputElement>(null);
  const idempotencyRef = useRef<{ amount: number; key: string } | null>(null);

  const [amount, setAmount] = useState(DEFAULT_AMOUNT);
  const [validationError, setValidationError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (payload: TopUpPayload) => topUpBalance(payload),
    onSuccess: (data) => {
      queryClient.setQueryData(balanceQueryKey, data.balance);
      void queryClient.invalidateQueries({ queryKey: balanceQueryKey });
      onClose();
    },
  });

  const parsedAmount = parseAmount(amount);
  const formattedBalance =
    balance === undefined ? '—' : formatMoney(balance, i18n.language);
  const serverError = mutation.isError
    ? getBillingErrorMessage(mutation.error, 'billing.errors.topUp')
    : null;
  const errorMessage = validationError ?? serverError;

  // Сбрасываем форму при каждом открытии. Зависимость только от open:
  // mutation.reset() не должен перезапускать эффект на каждый рендер.
  useEffect(() => {
    if (!open) {
      return;
    }

    setAmount(DEFAULT_AMOUNT);
    setValidationError(null);
    idempotencyRef.current = null;
    mutation.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;

    if (!dialog) {
      return;
    }

    if (open) {
      if (!dialog.open) {
        dialog.showModal();
      }

      const timeoutId = window.setTimeout(() => {
        amountInputRef.current?.focus();
        amountInputRef.current?.select();
      }, 0);

      return () => window.clearTimeout(timeoutId);
    }

    if (dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;

    if (!dialog) {
      return;
    }

    const handleClose = () => onClose();
    dialog.addEventListener('close', handleClose);

    return () => dialog.removeEventListener('close', handleClose);
  }, [onClose]);

  function handleAmountChange(value: string) {
    setAmount(value);
    setValidationError(null);

    if (mutation.isError) {
      mutation.reset();
    }
  }

  function getIdempotencyKey(amountValue: number): string {
    const existing = idempotencyRef.current;

    if (existing?.amount === amountValue) {
      return existing.key;
    }

    const key = crypto.randomUUID();
    idempotencyRef.current = { amount: amountValue, key };

    return key;
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (parsedAmount === null) {
      setValidationError(t('billing.errors.invalidAmount'));
      return;
    }

    if (userId === '') {
      setValidationError(t('billing.errors.sessionExpired'));
      return;
    }

    setValidationError(null);
    mutation.mutate({
      userId,
      amount: parsedAmount,
      idempotencyKey: getIdempotencyKey(parsedAmount),
    });
  }

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="topup-title"
      aria-describedby="topup-description"
      className="m-auto w-[calc(100%-2rem)] max-w-md overflow-hidden rounded-2xl border border-outline-variant bg-surface p-0 text-on-surface shadow-2xl"
    >
      <div className="max-h-[85svh] overflow-y-auto p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2
              id="topup-title"
              className="font-display text-xl font-bold tracking-tight text-on-surface"
            >
              {t('billing.topUpTitle')}
            </h2>
            <p
              id="topup-description"
              className="mt-1 text-sm text-on-surface-variant"
            >
              {t('billing.topUpSubtitle')}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="rounded-lg p-1.5 text-on-surface-variant transition hover:bg-surface-container-high hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              className="size-4"
            >
              <path d="m5 5 10 10M15 5 5 15" />
            </svg>
          </button>
        </div>

        <div className="mt-5 flex items-center justify-between gap-3 rounded-xl bg-surface-container px-4 py-3">
          <span className="text-sm text-on-surface-variant">
            {t('billing.currentBalance')}
          </span>
          <span className="font-display text-lg font-bold tabular-nums text-on-surface">
            {formattedBalance} {CURRENCY_SYMBOL}
          </span>
        </div>

        <form
          className="mt-5 space-y-4"
          onSubmit={handleSubmit}
          aria-busy={mutation.isPending}
          noValidate
        >
          <div>
            <label
              htmlFor="topup-amount"
              className="block text-sm font-medium text-on-surface"
            >
              {t('billing.amountLabel')}
            </label>

            <div
              role="group"
              aria-label={t('billing.presetsLabel')}
              className="mt-2 grid grid-cols-3 gap-2"
            >
              {PRESETS.map((preset) => {
                const isActive = amount === String(preset);

                return (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => handleAmountChange(String(preset))}
                    aria-pressed={isActive}
                    disabled={mutation.isPending}
                    className={`rounded-lg border px-2 py-2 text-sm font-semibold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-60 ${
                      isActive
                        ? 'border-primary bg-primary-container text-on-primary-container'
                        : 'border-outline bg-surface-container text-on-surface-variant hover:border-primary/40 hover:text-on-surface'
                    }`}
                  >
                    {preset} {CURRENCY_SYMBOL}
                  </button>
                );
              })}
            </div>

            <div className="relative mt-2">
              <input
                ref={amountInputRef}
                id="topup-amount"
                name="amount"
                type="number"
                min="0.01"
                step="0.01"
                inputMode="decimal"
                required
                value={amount}
                onChange={(event) => handleAmountChange(event.target.value)}
                disabled={mutation.isPending}
                aria-invalid={parsedAmount === null ? true : undefined}
                aria-describedby={
                  errorMessage !== null ? 'topup-error' : undefined
                }
                className="block w-full rounded-xl border border-outline bg-surface px-4 py-3 pr-10 text-sm text-on-surface outline-none transition placeholder:text-on-surface-variant/60 hover:border-primary/40 focus:border-primary focus:ring-4 focus:ring-primary/15 disabled:cursor-not-allowed disabled:opacity-60"
              />
              <span
                aria-hidden="true"
                className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-sm text-on-surface-variant"
              >
                {CURRENCY_SYMBOL}
              </span>
            </div>
          </div>

          {errorMessage !== null && (
            <div
              id="topup-error"
              role="alert"
              className="rounded-xl border border-error/30 bg-error-container px-4 py-3 text-sm text-on-error-container"
            >
              {errorMessage}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-outline px-4 py-2.5 text-sm font-medium text-on-surface-variant transition hover:border-primary/40 hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={parsedAmount === null || mutation.isPending}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-on-primary shadow-lg shadow-primary/25 transition hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary active:brightness-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {mutation.isPending && (
                <svg
                  aria-hidden="true"
                  viewBox="0 0 24 24"
                  fill="none"
                  className="size-4 animate-spin"
                >
                  <circle
                    cx="12"
                    cy="12"
                    r="9"
                    stroke="currentColor"
                    strokeOpacity="0.25"
                    strokeWidth="3"
                  />
                  <path
                    d="M21 12a9 9 0 0 0-9-9"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                  />
                </svg>
              )}
              {mutation.isPending ? t('billing.processing') : t('billing.pay')}
            </button>
          </div>
        </form>
      </div>
    </dialog>
  );
}
