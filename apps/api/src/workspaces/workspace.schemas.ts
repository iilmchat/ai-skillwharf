import { z } from 'zod';

/** Роли воркспейса (ORG-31.1/31.2). */
export const workspaceRoleSchema = z.enum([
  'owner',
  'admin',
  'operator',
  'viewer',
]);
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;

export const assignableWorkspaceRoleSchema = z.enum([
  'admin',
  'operator',
  'viewer',
]);

export const moneySchema = z.number().nonnegative().finite().max(1_000_000_000);

export const slugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'ожидается kebab-case slug');

/** POST /workspaces. */
export const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(128),
  slug: slugSchema.optional(),
});

/** POST /workspaces/:id/members. */
export const addWorkspaceMemberSchema = z.object({
  email: z.email(),
  role: assignableWorkspaceRoleSchema,
  hitlApprovalLimitRub: moneySchema.optional(),
});

/** PATCH /workspaces/:id/members/:memberId. */
export const updateWorkspaceMemberSchema = z
  .object({
    role: assignableWorkspaceRoleSchema.optional(),
    hitlApprovalLimitRub: moneySchema.nullable().optional(),
  })
  .refine(
    (value) =>
      value.role !== undefined || value.hitlApprovalLimitRub !== undefined,
    { message: 'укажите role или hitlApprovalLimitRub' },
  );

/** Заголовок X-Workspace-Id — опциональный, пусто = дефолтный воркспейс. */
export const workspaceHeaderSchema = z.string().uuid().optional();

export const workspaceViewSchema = z.object({
  id: z.string(),
  organizationId: z.string(),
  name: z.string(),
  slug: z.string(),
  isDefault: z.boolean(),
  role: workspaceRoleSchema,
  hitlApprovalLimitRub: z.string().nullable(),
});

export type WorkspaceView = z.infer<typeof workspaceViewSchema>;

export const workspaceMemberViewSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  userId: z.string(),
  email: z.string(),
  role: workspaceRoleSchema,
  hitlApprovalLimitRub: z.string().nullable(),
  createdAt: z.string(),
});

export type WorkspaceMemberView = z.infer<typeof workspaceMemberViewSchema>;
