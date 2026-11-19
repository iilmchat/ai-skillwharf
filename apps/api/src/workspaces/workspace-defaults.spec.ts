import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import {
  defaultWorkspaceId,
  ensureDefaultWorkspace,
} from './workspace-defaults.js';

function harness(existing: boolean) {
  const prisma = {
    workspaceMember: {
      findFirst: vi.fn(async () => (existing ? { id: 'member-1', workspaceId: 'ws-1' } : null)),
      upsert: vi.fn(async () => ({ id: 'member-1' })),
    },
    organization: { upsert: vi.fn(async () => ({ id: 'org-1' })) },
    workspace: { upsert: vi.fn(async () => ({ id: 'ws-1' })) },
  };

  return { prisma: prisma as unknown as PrismaService, mocks: prisma };
}

describe('ensureDefaultWorkspace (ORG-31.1)', () => {
  it('создаёт organization, workspace и роль owner для нового пользователя', async () => {
    const { prisma, mocks } = harness(false);

    await ensureDefaultWorkspace(prisma, 'user-1', 'ivan@example.com');

    expect(mocks.organization.upsert).toHaveBeenCalledTimes(1);
    expect(mocks.workspace.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId_slug: { organizationId: 'org-1', slug: 'default' },
        },
      }),
    );
    expect(mocks.workspaceMember.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ userId: 'user-1', role: 'owner' }),
      }),
    );
  });

  it('не создаёт ничего повторно для существующего пользователя', async () => {
    const { prisma, mocks } = harness(true);

    await ensureDefaultWorkspace(prisma, 'user-1', 'ivan@example.com');

    expect(mocks.organization.upsert).not.toHaveBeenCalled();
    expect(mocks.workspace.upsert).not.toHaveBeenCalled();
  });

  it('defaultWorkspaceId возвращает ID дефолтного воркспейса', async () => {
    const { prisma } = harness(true);

    await expect(defaultWorkspaceId(prisma, 'user-1')).resolves.toBe('ws-1');
  });
});
