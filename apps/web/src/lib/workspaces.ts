import type { QueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { api } from './api';
import {
  getErrorMetaFromError,
  getKnownErrorMessageKey,
} from './chat-errors';

/**
 * Контракт мульти-тенантности (Sprint 31, ORG-31.1/ORG-31.2).
 *
 * Бэкенд может отдавать лимит HITL числом, строкой Decimal или `null`,
 * поэтому схема принимает все три формы; UI сам решает, как его показать.
 */
export const workspaceRoleSchema = z.enum([
  'owner',
  'admin',
  'operator',
  'viewer',
]);

export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;

export const hitlLimitSchema = z
  .union([z.number().nonnegative(), z.string()])
  .nullable()
  .optional();

export const workspaceSchema = z.object({
  id: z.string().min(1),
  organizationId: z.string().min(1),
  name: z.string().min(1),
  slug: z.string().min(1),
  isDefault: z.boolean(),
  role: workspaceRoleSchema,
  hitlApprovalLimitRub: hitlLimitSchema,
});

export type Workspace = z.infer<typeof workspaceSchema>;

export const workspaceMemberSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  email: z.string().optional(),
  name: z.string().optional(),
  role: workspaceRoleSchema,
  hitlApprovalLimitRub: hitlLimitSchema,
});

export type WorkspaceMember = z.infer<typeof workspaceMemberSchema>;

const workspaceListSchema = z.preprocess(
  (value) =>
    typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>).items ??
        (value as Record<string, unknown>).workspaces ??
        (value as Record<string, unknown>).data ??
        value
      : value,
  z.array(workspaceSchema),
);

const workspaceMemberListSchema = z.preprocess(
  (value) =>
    typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>).items ??
        (value as Record<string, unknown>).members ??
        (value as Record<string, unknown>).data ??
        value
      : value,
  z.array(workspaceMemberSchema),
);

export const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(128),
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .optional(),
});

export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;

const memberRoleSchema = z.enum(['admin', 'operator', 'viewer']);

export const addWorkspaceMemberSchema = z.object({
  email: z.string().trim().email().max(254),
  role: memberRoleSchema,
  hitlApprovalLimitRub: z.number().nonnegative().optional(),
});

export type AddWorkspaceMemberInput = z.infer<
  typeof addWorkspaceMemberSchema
>;

export const updateWorkspaceMemberSchema = z.object({
  role: workspaceRoleSchema.optional(),
  hitlApprovalLimitRub: z.number().nonnegative().nullable().optional(),
});

export type UpdateWorkspaceMemberInput = z.infer<
  typeof updateWorkspaceMemberSchema
>;

export const workspaceQueryKeys = {
  workspaces: ['workspaces'] as const,
  members: (workspaceId: string) =>
    ['workspaces', workspaceId, 'members'] as const,
};

/** Явно выбранный воркспейс, иначе default, иначе первый из списка. */
export function resolveActiveWorkspace(
  workspaces: Workspace[],
  selectedId: string | null,
): Workspace | undefined {
  return (
    workspaces.find((item) => item.id === selectedId) ??
    workspaces.find((item) => item.isDefault) ??
    workspaces[0]
  );
}

/** Права на управление участниками: owner и admin. */
export function canManageWorkspaceMembers(role: WorkspaceRole | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

export function parseHitlLimit(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

/**
 * Возвращает i18n-ключ ошибки воркспейса:machine-readable `code` API имеет
 * приоритет перед текстом, чтобы `errors.insufficient_workspace_role` и
 * `errors.hitl_limit_exceeded` переводились на RU/EN.
 */
export function workspaceErrorKey(
  error: unknown,
  fallbackKey: string,
): string {
  const code = getErrorMetaFromError(error).code;

  return getKnownErrorMessageKey(code) ?? fallbackKey;
}

/**
 * Смена воркспейса меняет область данных: кэши чатов, навыков, маркетплейса
 * и интеграций нужно сбросить, чтобы не показать данные прошлого воркспейса.
 */
export function invalidateWorkspaceScopedCaches(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: ['chat'] });
  void queryClient.invalidateQueries({ queryKey: ['skills'] });
  void queryClient.invalidateQueries({ queryKey: ['marketplace'] });
  void queryClient.invalidateQueries({ queryKey: ['integrations'] });
  void queryClient.invalidateQueries({ queryKey: ['registry', 'skills'] });
}

export async function fetchWorkspaces(): Promise<Workspace[]> {
  const { data } = await api.get<unknown>('/workspaces');

  return workspaceListSchema.parse(data);
}

export async function createWorkspace(
  input: CreateWorkspaceInput,
): Promise<Workspace> {
  const payload = createWorkspaceSchema.parse(input);
  const { data } = await api.post<unknown>('/workspaces', payload);

  return workspaceSchema.parse(data);
}

export async function fetchWorkspaceMembers(
  workspaceId: string,
): Promise<WorkspaceMember[]> {
  const { data } = await api.get<unknown>(
    `/workspaces/${encodeURIComponent(workspaceId)}/members`,
  );

  return workspaceMemberListSchema.parse(data);
}

export async function addWorkspaceMember(
  workspaceId: string,
  input: AddWorkspaceMemberInput,
): Promise<WorkspaceMember> {
  const payload = addWorkspaceMemberSchema.parse(input);
  const { data } = await api.post<unknown>(
    `/workspaces/${encodeURIComponent(workspaceId)}/members`,
    payload,
  );

  return workspaceMemberSchema.parse(data);
}

export async function updateWorkspaceMember(
  workspaceId: string,
  memberId: string,
  input: UpdateWorkspaceMemberInput,
): Promise<WorkspaceMember> {
  const payload = updateWorkspaceMemberSchema.parse(input);
  const { data } = await api.patch<unknown>(
    `/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(memberId)}`,
    payload,
  );

  return workspaceMemberSchema.parse(data);
}
