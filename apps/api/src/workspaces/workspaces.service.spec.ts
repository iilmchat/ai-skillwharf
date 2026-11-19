import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import { WorkspacesService } from './workspaces.service.js';

const OWNER = 'user-owner';
const VIEWER = 'user-viewer';
const WORKSPACE = '11111111-1111-4111-8111-111111111111';

function harness() {
  const members: Array<Record<string, unknown>> = [
    {
      id: 'member-owner',
      workspaceId: WORKSPACE,
      userId: OWNER,
      role: 'owner',
      hitlApprovalLimitRub: new Prisma.Decimal('1000.00'),
      createdAt: new Date('2026-11-19T00:00:00Z'),
      user: { email: 'owner@example.com' },
      workspace: {
        id: WORKSPACE,
        organizationId: 'org-1',
        name: 'Основной',
        slug: 'default',
        isDefault: true,
        createdAt: new Date('2026-11-19T00:00:00Z'),
      },
    },
    {
      id: 'member-viewer',
      workspaceId: WORKSPACE,
      userId: VIEWER,
      role: 'viewer',
      hitlApprovalLimitRub: new Prisma.Decimal('50.00'),
      createdAt: new Date('2026-11-19T00:00:00Z'),
      user: { email: 'viewer@example.com' },
      workspace: {
        id: WORKSPACE,
        organizationId: 'org-1',
        name: 'Основной',
        slug: 'default',
        isDefault: true,
        createdAt: new Date('2026-11-19T00:00:00Z'),
      },
    },
  ];
  const prisma = {
    workspaceMember: {
      findFirst: vi.fn(async ({ where }: { where?: Record<string, unknown> } = {}) =>
        members.find(
          (member) =>
            (where?.userId === undefined || member.userId === where.userId) &&
            (where?.workspaceId === undefined ||
              member.workspaceId === where.workspaceId),
        ) ?? null,
      ),
      findUnique: vi.fn(
        async ({ where }: { where: { workspaceId_userId?: { userId: string }; id?: string } }) =>
          where.workspaceId_userId !== undefined
            ? members.find(
                (member) =>
                  member.userId === where.workspaceId_userId?.userId &&
                  member.workspaceId === WORKSPACE,
              ) ?? null
            : members.find((member) => member.id === where.id) ?? null,
      ),
      findMany: vi.fn(async () => members),
      upsert: vi.fn(async (args: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
        const record = {
          id: 'member-new',
          createdAt: new Date(),
          user: { email: 'new@example.com' },
          ...args.create,
          ...args.update,
        };
        members.push(record);
        return record;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = members.find((member) => member.id === where.id);
        const updated = { ...row, ...data };
        members[members.indexOf(row as Record<string, unknown>)] = updated;
        return { ...updated, user: { email: 'viewer@example.com' } };
      }),
    },
    organization: {
      findFirst: vi.fn(async () => ({ id: 'org-1' })),
      upsert: vi.fn(async () => ({ id: 'org-1' })),
    },
    workspace: {
      findMany: vi.fn(async () => [
        {
          id: WORKSPACE,
          organizationId: 'org-1',
          name: 'Основной',
          slug: 'default',
          isDefault: true,
          createdAt: new Date(),
        },
      ]),
      upsert: vi.fn(async () => ({ id: WORKSPACE })),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => ({
        id: 'workspace-2',
        isDefault: false,
        ...args.data,
      })),
    },
    user: {
      findUnique: vi.fn(async () => ({ id: 'user-new', email: 'new@example.com' })),
    },
  };
  const service = new WorkspacesService(prisma as unknown as PrismaService);

  return { service, prisma, members };
}

describe('WorkspacesService (ORG-31.1/31.2)', () => {
  it('список воркспейсов содержит роль и лимит одобрения', async () => {
    const { service } = harness();
    const list = await service.listForUser(VIEWER, 'viewer@example.com');

    expect(list[0]).toMatchObject({
      id: WORKSPACE,
      role: 'owner',
      hitlApprovalLimitRub: '1000.00',
    });
  });

  it('управление участниками: добавление и изменение роли/лимита', async () => {
    const { service } = harness();
    const added = await service.addMember(OWNER, WORKSPACE, {
      email: 'new@example.com',
      role: 'operator',
      hitlApprovalLimitRub: 250,
    });

    expect(added).toMatchObject({ role: 'operator', hitlApprovalLimitRub: '250.00' });

    const updated = await service.updateMember(OWNER, WORKSPACE, 'member-viewer', {
      role: 'admin',
      hitlApprovalLimitRub: 5_000,
    });

    expect(updated).toMatchObject({ role: 'admin', hitlApprovalLimitRub: '5000.00' });
  });

  it('viewer не может управлять участниками (403 errors.insufficient_workspace_role)', async () => {
    const { service } = harness();

    await expect(
      service.addMember(VIEWER, WORKSPACE, {
        email: 'new@example.com',
        role: 'admin',
      }),
    ).rejects.toMatchObject({
      body: expect.objectContaining({ code: 'errors.insufficient_workspace_role' }),
    });
  });

  it('viewer не может запускать платные инструменты', async () => {
    const { service } = harness();

    await expect(
      service.assertRole(VIEWER, service.payingRoles()),
    ).rejects.toMatchObject({
      body: expect.objectContaining({ code: 'errors.insufficient_workspace_role' }),
    });
    await expect(service.assertRole(OWNER, service.payingRoles())).resolves.toBeUndefined();
  });

  it('превышение hitlApprovalLimitRub отклоняется (403 errors.hitl_limit_exceeded)', async () => {
    const { service } = harness();

    await expect(
      service.assertHitlLimit(VIEWER, 51, WORKSPACE),
    ).rejects.toMatchObject({
      body: expect.objectContaining({ code: 'errors.hitl_limit_exceeded' }),
    });
    await expect(
      service.assertHitlLimit(VIEWER, 50, WORKSPACE),
    ).resolves.toBeUndefined();
  });

  it('без X-Workspace-Id используется дефолтный воркспейс, а чужой — запрещён', async () => {
    const { service } = harness();

    expect(await service.resolveActive(VIEWER, undefined)).toMatchObject({
      workspaceId: WORKSPACE,
    });
    await expect(
      service.resolveActive(VIEWER, '99999999-9999-4999-8999-999999999999'),
    ).rejects.toThrow(/Нет доступа/);
  });
});
