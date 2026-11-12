import { isAxiosError } from 'axios';
import i18n from '../i18n';
import { api } from './api';

export type PricingModel =
  'Free' | 'Pay-per-Call' | 'Subscription' | 'Freemium';

export type SkillCurrency = 'RUB' | 'USD';

export interface SkillPricing {
  model: PricingModel;
  price?: number;
  currency?: SkillCurrency;
  freeCallsLimit?: number;
}

export interface SkillManifest {
  description?: string;
  pricing?: SkillPricing;
}

export interface InstalledSkill {
  id: string;
  name: string;
  version: string;
  author: string;
  manifest: SkillManifest;
  isEnabled: boolean;
  installedAt: string;
}

export interface ToggleSkillInput {
  id: string;
  isEnabled: boolean;
}

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

export async function fetchSkills(): Promise<InstalledSkill[]> {
  const { data } = await api.get<InstalledSkill[]>('/skills');

  return data;
}

export async function toggleSkill({
  id,
  isEnabled,
}: ToggleSkillInput): Promise<InstalledSkill> {
  const { data } = await api.patch<InstalledSkill>(
    `/skills/${encodeURIComponent(id)}/toggle`,
    { isEnabled },
  );

  return data;
}

export function getSkillsErrorMessage(
  error: unknown,
  fallbackKey: 'skills.errors.load' | 'skills.errors.toggle',
): string {
  if (isAxiosError(error)) {
    if (error.response === undefined) {
      return i18n.t('skills.errors.network');
    }

    const { status } = error.response;

    if (status === 401) {
      return i18n.t('skills.errors.sessionExpired');
    }

    if (status === 403) {
      return i18n.t('skills.errors.adminOnly');
    }

    if (status === 404) {
      return i18n.t('skills.errors.notFound');
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
