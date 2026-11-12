import { isAxiosError } from 'axios';
import i18n from '../i18n';
import { api } from './api';

export interface PromptTemplate {
  id: string;
  name: string;
  slug?: string;
  description?: string;
  isActive?: boolean;
  activeVersion?: string | number;
  currentVersion?: string | number;
  version?: string | number;
  versions?: PromptVersion[];
  updatedAt?: string;
}

export interface PromptVersion {
  id: string;
  templateId?: string;
  version?: string | number;
  content: string;
  environment?: string;
  createdBy?: string;
  createdAt?: string;
}

export type LlmProviderType = 'OpenAI' | 'YandexGPT' | 'GigaChat';

export interface LlmRoute {
  id: string;
  name: string;
  modelName: string;
  model?: string;
  providerType?: LlmProviderType;
  baseUrl?: string;
  baseURL?: string;
  apiKeyEnvVar?: string | null;
  priority?: number;
  isActive?: boolean;
}

export interface CreateLlmRouteInput {
  name: string;
  modelName: string;
  providerType: LlmProviderType;
  baseUrl: string;
  priority: number;
}

export interface AuditEntry {
  id: string;
  action: string;
  actor?: string;
  actorEmail?: string;
  userId?: string;
  entityType?: string;
  entityId?: string;
  target?: string;
  targetType?: string;
  targetId?: string;
  metadata?: unknown;
  createdAt?: string;
}

export const adminQueryKeys = {
  prompts: ['admin', 'prompts'] as const,
  promptVersions: (promptId: string) =>
    ['admin', 'prompts', promptId, 'versions'] as const,
  llmRoutes: ['admin', 'llm-routes'] as const,
  audit: ['admin', 'audit'] as const,
};

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

/**
 * Бэкенд может вернуть как массив, так и обёртку `{ items: [...] }`.
 * Для админских списков это допустимо, поэтому принимаем оба варианта.
 */
function unwrapList<T>(value: unknown, keys: readonly string[]): T[] {
  if (Array.isArray(value)) {
    return value as T[];
  }

  if (isRecord(value)) {
    for (const key of keys) {
      const list = value[key];

      if (Array.isArray(list)) {
        return list as T[];
      }
    }
  }

  return [];
}

export async function fetchPrompts(): Promise<PromptTemplate[]> {
  const { data } = await api.get<unknown>('/prompts');

  return unwrapList<PromptTemplate>(data, ['prompts', 'items', 'data']);
}

export async function fetchPromptVersions(
  promptId: string,
): Promise<PromptVersion[]> {
  const encodedId = encodeURIComponent(promptId);

  try {
    const { data } = await api.get<unknown>(`/prompts/${encodedId}/versions`);

    return unwrapList<PromptVersion>(data, ['versions', 'items', 'data']);
  } catch (error) {
    // Некоторые реализации отдают версии внутри карточки шаблона.
    if (isAxiosError(error) && error.response?.status === 404) {
      const { data } = await api.get<unknown>(`/prompts/${encodedId}`);

      if (isRecord(data)) {
        const versions =
          data.versions ??
          (isRecord(data.prompt) ? data.prompt.versions : undefined);

        if (Array.isArray(versions)) {
          return versions as PromptVersion[];
        }
      }
    }

    throw error;
  }
}

export async function createPromptVersion(
  promptId: string,
  content: string,
): Promise<PromptVersion> {
  const { data } = await api.post<PromptVersion>(
    `/prompts/${encodeURIComponent(promptId)}/versions`,
    { content },
  );

  return data;
}

export async function fetchLlmRoutes(): Promise<LlmRoute[]> {
  const { data } = await api.get<unknown>('/admin/llm-routes');

  return unwrapList<LlmRoute>(data, ['routes', 'rules', 'items', 'data']);
}

export async function createLlmRoute(
  input: CreateLlmRouteInput,
): Promise<LlmRoute> {
  const { data } = await api.post<LlmRoute>('/admin/llm-routes', input);

  return data;
}

export async function fetchAudit(): Promise<AuditEntry[]> {
  const { data } = await api.get<unknown>('/admin/audit');

  return unwrapList<AuditEntry>(data, [
    'entries',
    'events',
    'items',
    'data',
  ]);
}

export function getAdminErrorMessage(
  error: unknown,
  fallbackKey: string,
): string {
  if (isAxiosError(error)) {
    if (error.response === undefined) {
      return i18n.t('admin.errors.network');
    }

    const { status } = error.response;

    if (status === 401) {
      return i18n.t('admin.errors.sessionExpired');
    }

    if (status === 403) {
      return i18n.t('admin.errors.adminOnly');
    }

    if (status === 404) {
      return i18n.t('admin.errors.notAvailable');
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

export function formatAdminDate(
  value: string | undefined,
  language: string,
): string {
  if (value === undefined || value === '') {
    return '—';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(language, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export function getPromptVersionLabel(prompt: PromptTemplate): string {
  const version =
    prompt.versions?.[0]?.version ??
    prompt.activeVersion ??
    prompt.currentVersion ??
    prompt.version;

  return version === undefined ? '—' : String(version);
}

export function getLlmRouteModel(route: LlmRoute): string {
  return route.modelName ?? route.model ?? '—';
}

export function getLlmRouteProvider(route: LlmRoute): LlmProviderType {
  return route.providerType ?? 'OpenAI';
}

export function getLlmRouteBaseUrl(route: LlmRoute): string {
  return route.baseUrl ?? route.baseURL ?? '—';
}

export function getAuditActor(entry: AuditEntry): string {
  return entry.actor ?? entry.actorEmail ?? entry.userId ?? '—';
}

export function getAuditTarget(entry: AuditEntry): string {
  if (entry.target !== undefined && entry.target !== '') {
    return entry.target;
  }

  const id = entry.entityId ?? entry.targetId ?? '';
  const type = entry.entityType ?? entry.targetType ?? '';

  if (type !== '' && id !== '') {
    return `${type}: ${id}`;
  }

  return id !== '' ? id : '—';
}
