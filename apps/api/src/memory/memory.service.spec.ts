import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { EmbeddingsService } from './embeddings.service.js';
import {
  MEMORY_TOP_K,
  MemoryService,
  formatMemoryChunks,
  toVectorLiteral,
} from './memory.service.js';

const USER_ID = '22222222-2222-2222-2222-222222222222';
const EMBEDDING = [0.1, 0.2, 0.3];

function createEmbeddings(embedding: number[] | null = EMBEDDING) {
  return {
    isConfigured: vi.fn().mockReturnValue(true),
    embed: vi.fn().mockResolvedValue(embedding),
  };
}

function createPrisma() {
  return {
    memoryChunk: {
      create: vi.fn().mockResolvedValue({ id: 'chunk-1' }),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    $executeRaw: vi.fn().mockResolvedValue(1),
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
}

function createService() {
  const prisma = createPrisma();
  const embeddings = createEmbeddings();
  const service = new MemoryService(
    prisma as unknown as PrismaService,
    embeddings as unknown as EmbeddingsService,
  );

  return { service, prisma, embeddings };
}

describe('toVectorLiteral', () => {
  it('сериализует вектор в литерал pgvector', () => {
    expect(toVectorLiteral([0.5, -1])).toBe('[0.5,-1]');
  });
});

describe('formatMemoryChunks', () => {
  it('нумерует фрагменты, убирает пустые и повторяющиеся', () => {
    expect(formatMemoryChunks(['самовывоз', 'самовывоз', '  ', 'скидка'])).toBe(
      '1. самовывоз\n2. скидка',
    );
    expect(formatMemoryChunks([])).toBe('');
  });
});

describe('MemoryService.remember', () => {
  it('сохраняет чанк и записывает эмбеддинг raw-запросом', async () => {
    const { service, prisma, embeddings } = createService();

    await service.remember(USER_ID, '  Клиент любит самовывоз  ');

    expect(embeddings.embed).toHaveBeenCalledWith('Клиент любит самовывоз');
    expect(prisma.memoryChunk.create).toHaveBeenCalledWith({
      data: { userId: USER_ID, content: 'Клиент любит самовывоз' },
      select: { id: true },
    });

    const [, ...values] = prisma.$executeRaw.mock.calls[0] as [
      unknown,
      ...unknown[],
    ];

    expect(values).toEqual(['[0.1,0.2,0.3]', 'chunk-1']);
  });

  it('пропускает запись без настроенных эмбеддингов', async () => {
    const { prisma } = createService();
    const disabled = {
      isConfigured: vi.fn().mockReturnValue(false),
      embed: vi.fn(),
    };
    const noEmbeddings = new MemoryService(
      prisma as unknown as PrismaService,
      disabled as unknown as EmbeddingsService,
    );

    await noEmbeddings.remember(USER_ID, 'текст');

    expect(disabled.embed).not.toHaveBeenCalled();
    expect(prisma.memoryChunk.create).not.toHaveBeenCalled();
  });

  it('не падает, если БД отклонила запись', async () => {
    const { service, prisma } = createService();
    prisma.memoryChunk.create.mockRejectedValue(new Error('db down'));

    await expect(service.remember(USER_ID, 'текст')).resolves.toBeUndefined();
  });
});

describe('MemoryService.search', () => {
  it('ищет top-3 фрагмента по косинусному расстоянию', async () => {
    const { service, prisma, embeddings } = createService();
    prisma.$queryRaw.mockResolvedValue([
      { content: 'самовывоз' },
      { content: 'скидка 10%' },
    ]);

    const chunks = await service.search(USER_ID, 'где забрать заказ?');

    expect(embeddings.embed).toHaveBeenCalledWith('где забрать заказ?');
    expect(chunks).toEqual(['самовывоз', 'скидка 10%']);

    const [, ...values] = prisma.$queryRaw.mock.calls[0] as [
      unknown,
      ...unknown[],
    ];

    // userId, литерал вектора, лимит — всё передаётся параметрами.
    expect(values).toEqual([USER_ID, '[0.1,0.2,0.3]', MEMORY_TOP_K]);
  });

  it('возвращает пустой массив без эмбеддинга запроса', async () => {
    const prisma = createPrisma();
    const embeddings = createEmbeddings(null);
    const service = new MemoryService(
      prisma as unknown as PrismaService,
      embeddings as unknown as EmbeddingsService,
    );

    await expect(service.search(USER_ID, 'текст')).resolves.toEqual([]);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('не падает при ошибке БД', async () => {
    const { service, prisma } = createService();
    prisma.$queryRaw.mockRejectedValue(new Error('db down'));

    await expect(service.search(USER_ID, 'текст')).resolves.toEqual([]);
  });
});

describe('MemoryService.buildContext', () => {
  it('собирает нумерованный блок памяти для промпта', async () => {
    const { service, prisma } = createService();
    prisma.$queryRaw.mockResolvedValue([
      { content: 'самовывоз' },
      { content: 'скидка 10%' },
    ]);

    await expect(service.buildContext(USER_ID, 'заказ')).resolves.toBe(
      '1. самовывоз\n2. скидка 10%',
    );
  });
});

describe('MemoryService.clear', () => {
  it('удаляет все фрагменты памяти пользователя (GDPR/152-ФЗ)', async () => {
    const { service, prisma } = createService();
    prisma.memoryChunk.deleteMany.mockResolvedValue({ count: 3 });

    await expect(service.clear(USER_ID)).resolves.toBe(3);
    expect(prisma.memoryChunk.deleteMany).toHaveBeenCalledWith({
      where: { userId: USER_ID },
    });
  });
});

describe('MemoryService.list', () => {
  it('отдаёт страницу памяти пользователя от новых к старым', async () => {
    const { service, prisma } = createService();
    const createdAt = new Date('2026-11-13T10:00:00.000Z');
    prisma.memoryChunk.findMany.mockResolvedValue([
      {
        id: 'chunk-1',
        content: 'Клиент предпочитает самовывоз',
        createdAt,
      },
    ]);
    prisma.memoryChunk.count.mockResolvedValue(7);

    await expect(
      service.list(USER_ID, { limit: 5, offset: 10 }),
    ).resolves.toEqual({
      items: [
        {
          id: 'chunk-1',
          content: 'Клиент предпочитает самовывоз',
          createdAt: '2026-11-13T10:00:00.000Z',
        },
      ],
      total: 7,
    });

    expect(prisma.memoryChunk.findMany).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      orderBy: { createdAt: 'desc' },
      skip: 10,
      take: 5,
      select: { id: true, content: true, createdAt: true },
    });
    expect(prisma.memoryChunk.count).toHaveBeenCalledWith({
      where: { userId: USER_ID },
    });
  });

  it('возвращает пустую страницу, если памяти нет', async () => {
    const { service } = createService();

    await expect(
      service.list(USER_ID, { limit: 20, offset: 0 }),
    ).resolves.toEqual({ items: [], total: 0 });
  });

  it('сериализует createdAt в ISO 8601', async () => {
    const { service, prisma } = createService();
    prisma.memoryChunk.findMany.mockResolvedValue([
      { id: 'chunk-1', content: 'скидка 10%', createdAt: new Date(0) },
    ]);
    prisma.memoryChunk.count.mockResolvedValue(1);

    const page = await service.list(USER_ID, { limit: 1, offset: 0 });

    expect(page.items[0]?.createdAt).toBe('1970-01-01T00:00:00.000Z');
  });
});
