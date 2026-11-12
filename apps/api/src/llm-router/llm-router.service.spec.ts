import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { LlmRouterService } from './llm-router.service.js';

type MockFn = ReturnType<typeof vi.fn>;

interface PrismaMock {
  llmRoute: {
    findFirst: MockFn;
    findMany: MockFn;
    findUnique: MockFn;
    create: MockFn;
    update: MockFn;
    delete: MockFn;
  };
}

interface AuditMock {
  record: MockFn;
}

describe('LlmRouterService', () => {
  let service: LlmRouterService;
  let prisma: PrismaMock;
  let audit: AuditMock;

  beforeEach(() => {
    prisma = {
      llmRoute: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
    };
    audit = { record: vi.fn() };

    service = new LlmRouterService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
    );
  });

  it('выбирает активный маршрут с минимальным priority', async () => {
    prisma.llmRoute.findFirst.mockResolvedValue({
      id: 'route-1',
      name: 'local',
      modelName: 'llama3',
      baseUrl: 'http://localhost:11435/v1',
      apiKeyEnvVar: null,
      priority: 0,
      isActive: true,
    });

    await expect(service.selectRoute()).resolves.toEqual({
      id: 'route-1',
      name: 'local',
      modelName: 'llama3',
      baseUrl: 'http://localhost:11435/v1',
      apiKeyEnvVar: null,
    });
    expect(prisma.llmRoute.findFirst).toHaveBeenCalledWith({
      where: { isActive: true },
      orderBy: { priority: 'asc' },
    });
  });

  it('возвращает null, если активных маршрутов нет', async () => {
    prisma.llmRoute.findFirst.mockResolvedValue(null);

    await expect(service.selectRoute()).resolves.toBeNull();
  });

  it('возвращает null при ошибке БД, чтобы сработал env-fallback', async () => {
    prisma.llmRoute.findFirst.mockRejectedValue(new Error('db down'));

    await expect(service.selectRoute()).resolves.toBeNull();
  });

  it('создаёт маршрут и пишет аудит', async () => {
    prisma.llmRoute.create.mockResolvedValue({
      id: 'route-1',
      name: 'local',
      modelName: 'llama3',
      baseUrl: 'http://localhost:11435/v1',
      apiKeyEnvVar: null,
      priority: 0,
      isActive: true,
    });

    await expect(
      service.create(
        {
          name: 'local',
          model: 'llama3',
          baseUrl: 'http://localhost:11435/v1',
        },
        'admin-1',
      ),
    ).resolves.toMatchObject({ id: 'route-1', model: 'llama3' });
    expect(prisma.llmRoute.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ modelName: 'llama3' }),
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'admin-1',
        action: 'llm_route.create',
        entityType: 'LlmRoute',
        entityId: 'route-1',
      }),
    );
  });
});
