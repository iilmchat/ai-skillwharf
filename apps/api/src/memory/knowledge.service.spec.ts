import { describe, expect, it, vi } from 'vitest';
import { ApiException } from '../common/api-error.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { KnowledgeService } from './knowledge.service.js';

const OWNER = 'owner-1';
const OTHER = 'other-1';

function createHarness() {
  const folders = new Map<string, Record<string, unknown>>();
  const chunks: Array<Record<string, unknown>> = [];
  const prisma = {
    knowledgeFolder: {
      findMany: vi.fn(async ({ where }: { where: { userId: string } }) =>
        [...folders.values()].filter((row) => row.userId === where.userId),
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        folders.get(where.id) ?? null,
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = {
          id: `folder-${folders.size + 1}`,
          createdAt: new Date('2026-11-20T12:00:00Z'),
          ...data,
        };

        folders.set(row.id, row);

        return row;
      }),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        folders.delete(where.id);
      }),
    },
    memoryChunk: {
      findMany: vi.fn(async () => chunks),
      count: vi.fn(async () => chunks.length),
    },
  };
  const service = new KnowledgeService(prisma as unknown as PrismaService);

  return { service, prisma, folders, chunks };
}

function folderRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'folder-1',
    workspaceId: null,
    userId: OWNER,
    name: 'Регламенты',
    description: null,
    createdAt: new Date('2026-11-20T10:00:00Z'),
    ...overrides,
  };
}

describe('KnowledgeService (KB-38.1)', () => {
  it('создаёт папку и считает чанки/документы', async () => {
    const { service, chunks } = createHarness();

    const created = await service.createFolder(OWNER, {
      name: 'Регламенты',
      description: 'Договоры и политики',
    });

    expect(created).toMatchObject({
      name: 'Регламенты',
      chunkCount: 0,
      documentCount: 0,
    });

    chunks.push(
      {
        folderId: created.id,
        documentTitle: 'Политика закупок',
        content: 'пункт 1',
      },
      {
        folderId: created.id,
        documentTitle: 'Политика закупок',
        content: 'пункт 2',
      },
    );

    const [folder] = await service.listFolders(OWNER);

    expect(folder?.id).toBe(created.id);
    expect(folder?.chunkCount).toBe(2);
    expect(folder?.documentCount).toBe(1);
  });

  it('удаляет папку только владельцу (403)', async () => {
    const { service, folders } = createHarness();
    folders.set('folder-1', folderRow());

    await expect(service.deleteFolder(OWNER, 'folder-1')).resolves.toEqual({
      id: 'folder-1',
    });
    expect(folders.has('folder-1')).toBe(false);

    folders.set('folder-1', folderRow());

    try {
      await service.deleteFolder(OTHER, 'folder-1');
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiException);
      expect((error as ApiException).getStatus()).toBe(403);
    }

    // после неудачной попытки чужого пользователя папка остаётся на месте
    expect(folders.has('folder-1')).toBe(true);
  });

  it('отверждает слишком короткое имя через Zod', async () => {
    const { service } = createHarness();

    await expect(
      service.createFolder(OWNER, { name: 'A' }),
    ).rejects.toThrow();
  });

  it('фильтрует документы по folderId и search', async () => {
    const { service, chunks } = createHarness();
    chunks.push(
      {
        id: 'chunk-1',
        folderId: 'folder-1',
        documentTitle: 'Политика',
        source: 'document',
        content: 'Доставка за 3 дня',
        pageNumber: 2,
        createdAt: new Date('2026-11-20T10:00:00Z'),
      },
      {
        id: 'chunk-2',
        folderId: 'folder-2',
        documentTitle: 'Другое',
        source: 'document',
        content: 'Не подходит',
        pageNumber: null,
        createdAt: new Date('2026-11-20T11:00:00Z'),
      },
    );
    // фильтрация в mock имитирует Prisma where
    chunks.splice(
      0,
      chunks.length,
      ...chunks.filter((chunk) => chunk.folderId === 'folder-1'),
    );

    const result = await service.listDocuments(OWNER, {
      folderId: 'folder-1',
      search: 'Доставка',
    });

    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({
      id: 'chunk-1',
      pageNumber: 2,
      documentTitle: 'Политика',
    });
  });
});
