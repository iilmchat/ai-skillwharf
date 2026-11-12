import { isAxiosError } from 'axios';
import i18n from '../i18n';
import { api } from './api';

export interface WalletBalance {
  balance: string;
  /** Замороженные средства Pay-per-Outcome. */
  heldBalance?: string;
}

export interface LedgerOperationResult extends WalletBalance {
  entryId: string;
}

export interface LedgerEntry {
  id: string;
  amount: string;
  balanceAfter: string;
  type: string;
  description: string;
  createdAt: string;
}

export interface TopUpPayload {
  userId: string;
  amount: number;
  idempotencyKey: string;
}

/** Ключ кэша истории операций. */
export const ledgerQueryKey = ['ledger'] as const;

interface MessagePayload {
  message: string | string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isMessagePayload(value: unknown): value is MessagePayload {
  if (!isRecord(value) || !('message' in value)) {
    return false;
  }

  const { message } = value;

  return (
    typeof message === 'string' ||
    (Array.isArray(message) &&
      message.every((item): item is string => typeof item === 'string'))
  );
}

function translateServerMessage(message: string): string {
  return message.startsWith('errors.') && i18n.exists(message)
    ? i18n.t(message)
    : message;
}

function formatServerMessage(message: string | string[]): string {
  return Array.isArray(message)
    ? message.map(translateServerMessage).join('; ')
    : translateServerMessage(message);
}

export async function fetchBalance(): Promise<WalletBalance> {
  const { data } = await api.get<WalletBalance>('/billing/balance');

  return data;
}

export async function topUpBalance(
  payload: TopUpPayload,
): Promise<LedgerOperationResult> {
  const { data } = await api.post<LedgerOperationResult>(
    '/billing/topup',
    payload,
  );

  return data;
}

export async function fetchLedger(): Promise<LedgerEntry[]> {
  const { data } = await api.get<LedgerEntry[]>('/billing/ledger');

  return data;
}

export function getBillingErrorMessage(
  error: unknown,
  fallbackKey:
    'billing.errors.load' | 'billing.errors.topUp' | 'billing.errors.ledger',
): string {
  if (isAxiosError(error)) {
    if (error.response === undefined) {
      return i18n.t('billing.errors.network');
    }

    const { status } = error.response;

    if (status === 401) {
      return i18n.t('billing.errors.sessionExpired');
    }

    if (status === 403) {
      return i18n.t('billing.errors.adminOnly');
    }

    const data: unknown = error.response.data;

    if (isMessagePayload(data)) {
      return formatServerMessage(data.message);
    }

    return i18n.t(fallbackKey);
  }

  if (error instanceof Error && error.message !== '') {
    return error.message;
  }

  return i18n.t(fallbackKey);
}
