import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { ApiException, insufficientWorkspaceRoleError } from '../common/api-error.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  createCustomAgentRoleSchema,
  updateCustomAgentRoleSchema,
} from './custom-agents.schemas.js';
import { CustomAgentRolesService } from './custom-agents.service.js';
import type { WorkspaceRole } from './workspace.schemas.js';
import type { WorkspacesService } from './workspaces.service.js';

interface RoleRow {
  id: string;
  workspaceId: string;
  name: string;
  roleKey: string;
  description: string | null;
  systemPrompt: string;
  skillSlugs: string[];
  hitlPolicy: string;
  dailyBudgetRub: Prisma.Decimal | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';
const ROLES: Record<string, WorkspaceRole> = {
  owner: 'owner',
  admin: 'admin',
  operator: 'operator',
  viewer: 'viewer',
};

const validBody = {
  name: 'Менеджер по закупкам',
  roleKey: 'purchase-manager',
  systemPrompt: 'Ты отвечаешь за закупки и согласовываешь договоры.',
  skillSlugs: ['erp-orders'],
  hitlPolicy: 'high_risk',
  dailyBudgetRub: 250,
};

async function expectForbidden(action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
    throw new Error('expected rejection');
  } catch (error) {
    expect(error).toBeInstanceOf(ApiException);
    const apiError = error as ApiException;

    expect(apiError.getStatus()).toBe(403);
    expect(apiError.getResponse()).toMatchObject({
      code: 'errors.insufficient_workspace_role',
    });
  }
}

function createHarness() {
  const store = new Map<string, RoleRow>();

  const prisma = {
    customAgentRole: {
      findMany: vi.fn(async ({ where }: { where: { workspaceId: string; isActive?: boolean } }) =>
        [...store.values()].filter(
          (row) =>
            row.workspaceId === where.workspaceId &&
            (where.isActive === undefined || row.isActive === where.isActive),
        ),
      ),
      findUnique: vi.fn(
        ({ where }: { where: { workspaceId_roleKey: { workspaceId: string; roleKey: string } } }) =>
          [...store.values()].find(
            (row) =>
              row.workspaceId === where.workspaceId_roleKey.workspaceId &&
              row.roleKey === where.workspaceId_roleKey.roleKey,
          ) ?? null,
      ),
      findFirst: vi.fn(
        ({ where }: { where: { id: string; workspaceId: string } }) =>
          store.get(where.id)?.workspaceId === where.workspaceId
            ? (store.get(where.id) ?? null)
            : null,
      ),
      create: vi.fn(async ({ data }: { data: Omit<RoleRow, 'id' | 'createdAt' | 'updatedAt'> }) => {
        const row: RoleRow = {
          ...data,
          dailyBudgetRub:
            data.dailyBudgetRub === null
              ? null
              : new Prisma.Decimal(data.dailyBudgetRub as number),
          id: `role-${store.size + 1}`,
          createdAt: new Date('2026-11-19T10:00:00Z'),
          updatedAt: new Date('2026-11-19T10:00:00Z'),
        };

        store.set(row.id, row);

        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<RoleRow> }) => {
        const row = store.get(where.id);

        if (row === undefined) {
          throw new Error('not found');
        }

        const updated = {
          ...row,
          ...data,
          ...(data.dailyBudgetRub !== undefined
            ? {
                dailyBudgetRub:
                  data.dailyBudgetRub === null
                    ? null
                    : new Prisma.Decimal(data.dailyBudgetRub as number),
              }
            : {}),
          updatedAt: new Date('2026-11-19T11:00:00Z'),
        };

        store.set(row.id, updated);

        return updated;
      }),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = store.get(where.id);

        if (row !== undefined) {
          store.delete(where.id);
        }

        return row ?? null;
      }),
    },
  };
  const workspaces = {
    assertRole: vi.fn(async (userId: string, allowed: ReadonlySet<WorkspaceRole>) => {
      const role = ROLES[userId] ?? 'viewer';

      if (!allowed.has(role)) {
        throw insufficientWorkspaceRoleError(`Роль ${role} не разрешает это действие`);
      }
    }),
  };
  const service = new CustomAgentRolesService(
    prisma as unknown as PrismaService,
    workspaces as unknown as WorkspacesService,
  );

  return { service, prisma, workspaces, store };
}

describe('CustomAgentRolesService CRUD (BUILDER-35.1/35.2/35.3)', () => {
  it('owner создаёт роль, читает список, редактирует и удаляет', async () => {
    const { service } = createHarness();

    const created = await service.create('owner', WORKSPACE_ID, validBody);

    expect(created.roleKey).toBe('purchase-manager');
    expect(created.dailyBudgetRub).toBe('250.00');
    expect(created.hitlPolicy).toBe('high_risk');

    const listed = await service.list('viewer', WORKSPACE_ID);

    expect(listed).toHaveLength(1);

    const patched = await service.update('admin', WORKSPACE_ID, created.id, {
      isActive: false,
      dailyBudgetRub: 0,
    });

    expect(patched.isActive).toBe(false);
    expect(patched.dailyBudgetRub).toBe('0.00');

    const removed = await service.remove('owner', WORKSPACE_ID, created.id);

    expect(removed.id).toBe(created.id);
    await expect(service.list('viewer', WORKSPACE_ID)).resolves.toEqual([]);
  });

  it('viewer и operator не могут создавать/изменять/удалять (403)', async () => {
    const { service } = createHarness();
    const created = await service.create('owner', WORKSPACE_ID, validBody);

    for (const action of [
      () => service.create('viewer', WORKSPACE_ID, validBody),
      () => service.create('operator', WORKSPACE_ID, validBody),
      () => service.update('viewer', WORKSPACE_ID, created.id, { isActive: false }),
      () => service.remove('operator', WORKSPACE_ID, created.id),
    ]) {
      await expectForbidden(action);
    }
  });

  it('не допускает дубль roleKey в одном воркспейсе', async () => {
    const { service } = createHarness();

    await service.create('owner', WORKSPACE_ID, validBody);

    await expect(
      service.create('owner', WORKSPACE_ID, validBody),
    ).rejects.toBeInstanceOf(ApiException);
  });

  it('загружает только активные роли для контекста чата', async () => {
    const { service } = createHarness();
    const created = await service.create('owner', WORKSPACE_ID, validBody);

    await expect(service.findActiveContext(WORKSPACE_ID)).resolves.toEqual([
      expect.objectContaining({
        roleKey: 'purchase-manager',
        skillSlugs: ['erp-orders'],
        dailyBudgetRub: 250,
      }),
    ]);

    await service.update('owner', WORKSPACE_ID, created.id, { isActive: false });

    await expect(service.findActiveContext(WORKSPACE_ID)).resolves.toEqual([]);
  });
});

describe('Zod-валидация конструктора ролей', () => {
  it('отверждает невалидный roleKey', () => {
    for (const roleKey of ['Purchase Manager', 'x', 'a'.repeat(41), 'ok_bad']) {
      expect(() => createCustomAgentRoleSchema.parse({ ...validBody, roleKey })).toThrow();
    }
  });

  it('отверждает отрицательный dailyBudgetRub', () => {
    expect(() =>
      createCustomAgentRoleSchema.parse({ ...validBody, dailyBudgetRub: -1 }),
    ).toThrow();
  });

  it('проверяет границы name и systemPrompt', () => {
    expect(() => createCustomAgentRoleSchema.parse({ ...validBody, name: 'A' })).toThrow();
    expect(() =>
      createCustomAgentRoleSchema.parse({ ...validBody, systemPrompt: 'коротко' }),
    ).toThrow();
  });

  it('PATCH требует хотя бы одно поле', () => {
    expect(() => updateCustomAgentRoleSchema.parse({})).toThrow();
  });
});
