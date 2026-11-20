import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { TokenCipherService } from '../integrations/google/token-cipher.service.js';
import type { WorkspacesService } from '../workspaces/workspaces.service.js';
import { CorpMessengerAdapterRegistry } from './adapters/corp-messenger.registry.js';
import {
  CorpChannelsService,
  maskCorpToken,
} from './corp-channels.service.js';

const WORKSPACE_ID = randomUUID();
const OWNER = 'owner-1';
const TOKEN = 'pachca-token-abcd1234';

function createHarness(rows: Array<Record<string, unknown>> = []) {
  const prisma = {
    corpMessengerChannel: {
      findMany: vi.fn(async () => rows),
      findFirst: vi.fn(async ({ where }: { where: { id: string; workspaceId: string } }) =>
        rows.find(
          (row) =>
            row.id === where.id && row.workspaceId === where.workspaceId,
        ) ?? null,
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        rows.find((row) => row.id === where.id) ?? null,
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          isActive: true,
          lastMessageAt: null,
          createdAt: new Date('2026-11-20T10:00:00Z'),
          updatedAt: new Date('2026-11-20T10:00:00Z'),
          ...data,
        };

        rows.push(row);

        return row;
      }),
      update: vi.fn(async () => rows[0]),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        const index = rows.findIndex((row) => row.id === where.id);

        if (index >= 0) {
          rows.splice(index, 1);
        }
      }),
    },
  };
  const cipher = {
    encrypt: vi.fn((token: string) => `v2:enc:${token}`),
    decrypt: vi.fn((envelope: string) => envelope.replace('v2:enc:', '')),
  };
  const workspaces = {
    resolveActive: vi.fn(async () => ({ workspaceId: WORKSPACE_ID })),
    managerRoles: vi.fn(() => new Set(['owner', 'admin'])),
    assertRole: vi.fn(async () => undefined),
  };
  const service = new CorpChannelsService(
    prisma as unknown as PrismaService,
    cipher as unknown as TokenCipherService,
    workspaces as unknown as WorkspacesService,
    new CorpMessengerAdapterRegistry(),
  );

  return { service, prisma, cipher, workspaces, rows };
}

describe('CorpChannelsService CRUD (OMNI-40.1/40.2)', () => {
  const input = {
    provider: 'pachca',
    name: 'Пачка Отдел закупок',
    botToken: TOKEN,
    allowedChatIds: [42, 'chat-7'],
  };

  it('создаёт канал, шифрует токен и маскирует его в GET', async () => {
    const { service, cipher } = createHarness();

    const created = await service.create(OWNER, WORKSPACE_ID, input);

    expect(cipher.encrypt).toHaveBeenCalledWith(TOKEN);
    expect(created.provider).toBe('pachca');
    expect(created.tokenMasked).toBe('****1234');
    expect(created.allowedChatIds).toEqual(['42', 'chat-7']);
    expect(created.webhookUrl).toBe(`/api/v1/webhooks/corporate/${created.id}`);
    expect(created.webhookSecret).toBeTruthy();
    expect(JSON.stringify(created)).not.toContain(TOKEN);

    const list = await service.list(OWNER, WORKSPACE_ID);

    expect(list[0]?.tokenMasked).toBe('****1234');
    expect(JSON.stringify(list)).not.toContain(TOKEN);
  });

  it('валидирует provider и apiBaseUrl через Zod', async () => {
    const { service } = createHarness();

    await expect(
      service.create(OWNER, WORKSPACE_ID, { ...input, provider: 'unknown' }),
    ).rejects.toThrow();
    await expect(
      service.create(OWNER, WORKSPACE_ID, {
        ...input,
        apiBaseUrl: 'ftp://legacy.local',
      }),
    ).rejects.toThrow();
  });

  it('удаляет только канал своего воркспейса', async () => {
    const { service, rows } = createHarness();

    const created = await service.create(OWNER, WORKSPACE_ID, input);

    await expect(
      service.remove(OWNER, WORKSPACE_ID, created.id),
    ).resolves.toEqual({ id: created.id });
    expect(rows).toHaveLength(0);
    await expect(
      service.remove(OWNER, WORKSPACE_ID, created.id),
    ).rejects.toThrow();
  });

  it('maskCorpToken не раскрывает короткие значения', () => {
    expect(maskCorpToken('abc')).toBe('********');
  });
});
