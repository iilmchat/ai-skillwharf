import { HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service.js';
import { ApiException } from '../common/api-error.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  LLM_BUDGET_EXHAUSTED_MESSAGE,
  LlmRouterService,
  startOfUtcDay,
} from './llm-router.service.js';

type MockFn = ReturnType<typeof vi.fn>;

interface LlmRouteRow {
  id: string;
  name: string;
  modelName: string;
  providerType: string;
  baseUrl: string;
  apiKeyEnvVar: string | null;
  priority: number;
  isActive: boolean;
  taskType: string;
  dailyCostLimit: Prisma.Decimal | null;
}

interface PrismaMock {
  llmRoute: {
    findFirst: MockFn;
    findMany: MockFn;
    findUnique: MockFn;
    create: MockFn;
    update: MockFn;
    delete: MockFn;
  };
  ledgerEntry: {
    aggregate: MockFn;
  };
}

interface AuditMock {
  record: MockFn;
}

/** Маршрут в форме строки БД с дефолтами. */
function routeRow(overrides: Partial<LlmRouteRow> = {}): LlmRouteRow {
  return {
    id: 'route-1',
    name: 'local',
    modelName: 'llama3',
    providerType: 'Ollama',
    baseUrl: 'http://localhost:11435/v1',
    apiKeyEnvVar: null,
    priority: 0,
    isActive: true,
    taskType: 'chat',
    dailyCostLimit: null,
    ...overrides,
  };
}

/** JSON-события из вызовов Nest-логгера (неструктурированные строки пропускает). */
function parseEvents(calls: readonly unknown[][]): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = [];

  for (const call of calls) {
    const message = call[0];

    if (typeof message !== 'string') {
      continue;
    }

    try {
      const parsed: unknown = JSON.parse(message);

      if (parsed !== null && typeof parsed === 'object' && 'event' in parsed) {
        events.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Неструктурированный текст лога — не событие.
    }
  }

  return events;
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
      ledgerEntry: {
        aggregate: vi.fn(),
      },
    };
    audit = { record: vi.fn() };

    service = new LlmRouterService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('выбирает активный маршрут с минимальным priority', async () => {
    prisma.llmRoute.findFirst.mockResolvedValue(routeRow({ priority: 0 }));

    await expect(service.selectRoute()).resolves.toEqual({
      id: 'route-1',
      name: 'local',
      modelName: 'llama3',
      providerType: 'Ollama',
      baseUrl: 'http://localhost:11435/v1',
      apiKeyEnvVar: null,
      taskType: 'chat',
      dailyCostLimit: null,
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

  describe('selectRoutes', () => {
    it('возвращает активные маршруты задачи по возрастанию priority', async () => {
      prisma.llmRoute.findMany.mockResolvedValue([
        routeRow({ id: 'route-1', name: 'primary', priority: 0 }),
        routeRow({ id: 'route-2', name: 'backup', priority: 1 }),
      ]);

      const routes = await service.selectRoutes('chat');

      expect(routes.map((route) => route.name)).toEqual(['primary', 'backup']);
      expect(routes[0]).toMatchObject({
        id: 'route-1',
        taskType: 'chat',
        dailyCostLimit: null,
      });
      expect(prisma.llmRoute.findMany).toHaveBeenCalledWith({
        where: { isActive: true, taskType: 'chat' },
        orderBy: { priority: 'asc' },
      });
      // У маршрутов без лимита расход не считается.
      expect(prisma.ledgerEntry.aggregate).not.toHaveBeenCalled();
    });

    it('фильтрует цепочку по типу задачи', async () => {
      prisma.llmRoute.findMany.mockResolvedValue([
        routeRow({ name: 'analyzer', taskType: 'analysis' }),
      ]);

      await service.selectRoutes('analysis');

      expect(prisma.llmRoute.findMany).toHaveBeenCalledWith({
        where: { isActive: true, taskType: 'analysis' },
        orderBy: { priority: 'asc' },
      });
    });

    it('исключает маршрут, исчерпавший дневной бюджет, и пишет событие', async () => {
      const warnSpy = vi.spyOn(Logger.prototype, 'warn');
      const now = new Date('2026-11-13T10:00:00.000Z');

      prisma.llmRoute.findMany.mockResolvedValue([
        routeRow({
          id: 'route-1',
          name: 'budgeted',
          dailyCostLimit: new Prisma.Decimal('10.00'),
        }),
        routeRow({ id: 'route-2', name: 'fallback', priority: 1 }),
      ]);
      prisma.ledgerEntry.aggregate.mockResolvedValue({
        _sum: { amount: new Prisma.Decimal('10.00') },
      });

      const routes = await service.selectRoutes('chat', now);

      expect(routes.map((route) => route.name)).toEqual(['fallback']);
      expect(prisma.ledgerEntry.aggregate).toHaveBeenCalledWith({
        where: {
          llmRouteName: 'budgeted',
          createdAt: { gte: startOfUtcDay(now) },
        },
        _sum: { amount: true },
      });

      const event = parseEvents(warnSpy.mock.calls).find(
        (candidate) => candidate.event === 'gen_ai.router.budget_exceeded',
      );

      expect(event).toMatchObject({
        route: 'budgeted',
        spend: 10,
        limit: 10,
      });
    });

    it('оставляет маршрут, если расход ещё меньше лимита', async () => {
      prisma.llmRoute.findMany.mockResolvedValue([
        routeRow({
          name: 'budgeted',
          dailyCostLimit: new Prisma.Decimal('10.00'),
        }),
      ]);
      prisma.ledgerEntry.aggregate.mockResolvedValue({
        _sum: { amount: new Prisma.Decimal('9.99') },
      });

      const routes = await service.selectRoutes(
        'chat',
        new Date('2026-11-13T10:00:00.000Z'),
      );

      expect(routes.map((route) => route.name)).toEqual(['budgeted']);
    });

    it('бросает 503 errors.llm_unavailable, если все маршруты исчерпали бюджет', async () => {
      vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      prisma.llmRoute.findMany.mockResolvedValue([
        routeRow({
          name: 'first',
          dailyCostLimit: new Prisma.Decimal('5.00'),
        }),
      ]);
      prisma.ledgerEntry.aggregate.mockResolvedValue({
        _sum: { amount: new Prisma.Decimal('5.00') },
      });

      const error = await service
        .selectRoutes('chat', new Date('2026-11-13T10:00:00.000Z'))
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(ApiException);
      expect((error as ApiException).getStatus()).toBe(
        HttpStatus.SERVICE_UNAVAILABLE,
      );
      expect((error as ApiException).getResponse()).toEqual({
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        error: 'Service Unavailable',
        code: 'errors.llm_unavailable',
        message: LLM_BUDGET_EXHAUSTED_MESSAGE,
      });
    });

    it('возвращает пустую цепочку, если маршрутов нет (env-fallback)', async () => {
      prisma.llmRoute.findMany.mockResolvedValue([]);

      await expect(service.selectRoutes('chat')).resolves.toEqual([]);
      expect(prisma.ledgerEntry.aggregate).not.toHaveBeenCalled();
    });

    it('возвращает пустую цепочку при ошибке БД, чтобы сработал env-fallback', async () => {
      prisma.llmRoute.findMany.mockRejectedValue(new Error('db down'));

      await expect(service.selectRoutes('chat')).resolves.toEqual([]);
    });
  });

  it('создаёт маршрут и пишет аудит', async () => {
    prisma.llmRoute.create.mockResolvedValue(
      routeRow({ providerType: 'YandexGPT', taskType: 'chat' }),
    );

    await expect(
      service.create(
        {
          name: 'local',
          model: 'llama3',
          providerType: 'YandexGPT',
          baseUrl: 'http://localhost:11435/v1',
        },
        'admin-1',
      ),
    ).resolves.toMatchObject({ id: 'route-1', model: 'llama3' });
    expect(prisma.llmRoute.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        modelName: 'llama3',
        providerType: 'YandexGPT',
      }),
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'admin-1',
        action: 'llm_route.create',
        entityType: 'LlmRoute',
        entityId: 'route-1',
        metadata: expect.objectContaining({ providerType: 'YandexGPT' }),
      }),
    );
  });

  it('создаёт маршрут с типом задачи и дневным лимитом', async () => {
    prisma.llmRoute.create.mockResolvedValue(
      routeRow({
        taskType: 'analysis',
        dailyCostLimit: new Prisma.Decimal('25.50'),
      }),
    );

    const view = await service.create(
      {
        name: 'local',
        model: 'llama3',
        baseUrl: 'http://localhost:11435/v1',
        taskType: 'analysis',
        dailyCostLimit: 25.5,
      },
      'admin-1',
    );

    expect(prisma.llmRoute.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        taskType: 'analysis',
        dailyCostLimit: 25.5,
      }),
    });
    // Decimal из БД отдаётся в API числом.
    expect(view).toMatchObject({
      taskType: 'analysis',
      dailyCostLimit: 25.5,
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          taskType: 'analysis',
          dailyCostLimit: 25.5,
        }),
      }),
    );
  });

  it('обновляет тип задачи и лимит с аудитом изменений', async () => {
    prisma.llmRoute.findUnique.mockResolvedValue(routeRow());
    prisma.llmRoute.update.mockResolvedValue(
      routeRow({ taskType: 'embeddings', dailyCostLimit: new Prisma.Decimal('1.00') }),
    );

    await service.update(
      'route-1',
      { taskType: 'embeddings', dailyCostLimit: 1 },
      'admin-1',
    );

    expect(prisma.llmRoute.update).toHaveBeenCalledWith({
      where: { id: 'route-1' },
      data: { taskType: 'embeddings', dailyCostLimit: 1 },
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'llm_route.update',
        metadata: {
          changes: { taskType: 'embeddings', dailyCostLimit: 1 },
        },
      }),
    );
  });
});
