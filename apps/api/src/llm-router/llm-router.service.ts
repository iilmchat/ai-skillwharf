import {
  BadRequestException,
  ConflictException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type LlmRoute } from '@prisma/client';
import { AuditService } from '../audit/audit.service.js';
import { ApiException } from '../common/api-error.js';
import { ERROR_KEYS } from '../i18n/error-keys.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateLlmRouteDto } from './dto/create-llm-route.dto.js';
import { UpdateLlmRouteDto } from './dto/update-llm-route.dto.js';

/** Текст ошибки, когда все маршруты задачи исчерпали дневной бюджет. */
export const LLM_BUDGET_EXHAUSTED_MESSAGE =
  'Все LLM-маршруты исчерпали дневной бюджет';

/** Параметры выбранного маршрута; ключ API остаётся в env. */
export interface LlmRouteSelection {
  id: string;
  name: string;
  modelName: string;
  providerType: string;
  baseUrl: string;
  apiKeyEnvVar: string | null;
  /** Тип задачи маршрута: fallback-цепочка строится внутри одного типа. */
  taskType: string;
  /** Дневной лимит затрат на маршрут в рублях; `null` — без лимита. */
  dailyCostLimit: number | null;
}

/** Маршрут с алиасом `model` для Control Plane UI. */
export type LlmRouteView = Omit<LlmRoute, 'dailyCostLimit'> & {
  model: string;
  /** Лимит в рублях числом: Decimal из БД в JSON был бы строкой. */
  dailyCostLimit: number | null;
};

@Injectable()
export class LlmRouterService {
  private readonly logger = new Logger(LlmRouterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Выбирает первый активный маршрут с наименьшим priority для `/llm/active`.
   * Бюджет здесь не проверяется: заголовку чата нужна информация о модели,
   * а не гарантия, что маршрут ещё не исчерпан. Если маршрутов нет или БД
   * недоступна, возвращает `null` — ChatService использует env-fallback.
   */
  async selectRoute(): Promise<LlmRouteSelection | null> {
    try {
      const route = await this.prisma.llmRoute.findFirst({
        where: { isActive: true },
        orderBy: { priority: 'asc' },
      });

      if (!route) {
        return null;
      }

      return toSelection(route);
    } catch (error) {
      this.logger.warn(
        `Не удалось выбрать LLM-маршрут, используется env-fallback: ${String(error)}`,
      );

      return null;
    }
  }

  /**
   * Строит fallback-цепочку для типа задачи: активные маршруты этого типа по
   * возрастанию priority, из которых исключены исчерпавшие дневной бюджет
   * (KI-010).
   *
   * Расход маршрута за текущие UTC-сутки считается по LedgerEntry с
   * `llmRouteName` маршрута: лимит проверяется до обращения к провайдеру.
   * Пустая таблица (или сбой БД) означает env-fallback — возвращается `[]`.
   * Если маршруты были, но все исключены бюджетом, клиент получает 503
   * `errors.llm_unavailable`: молча уходить на env-модель в этом случае
   * нельзя, иначе бюджетный предохранитель не работает.
   */
  async selectRoutes(
    taskType: string = 'chat',
    now: Date = new Date(),
  ): Promise<LlmRouteSelection[]> {
    let routes: LlmRoute[];

    try {
      routes = await this.prisma.llmRoute.findMany({
        where: { isActive: true, taskType },
        orderBy: { priority: 'asc' },
      });
    } catch (error) {
      this.logger.warn(
        `Не удалось выбрать LLM-маршруты, используется env-fallback: ${String(error)}`,
      );

      return [];
    }

    if (routes.length === 0) {
      return [];
    }

    const startOfDay = startOfUtcDay(now);
    const selected: LlmRouteSelection[] = [];

    for (const route of routes) {
      const limit = toNumber(route.dailyCostLimit);

      if (limit === null) {
        selected.push(toSelection(route));
        continue;
      }

      const aggregate = await this.prisma.ledgerEntry.aggregate({
        where: {
          llmRouteName: route.name,
          createdAt: { gte: startOfDay },
        },
        _sum: { amount: true },
      });
      const spend = toNumber(aggregate._sum.amount) ?? 0;

      if (spend >= limit) {
        this.logger.warn(
          JSON.stringify({
            event: 'gen_ai.router.budget_exceeded',
            route: route.name,
            spend,
            limit,
          }),
        );
        continue;
      }

      selected.push(toSelection(route));
    }

    if (selected.length === 0) {
      throw new ApiException({
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        error: 'Service Unavailable',
        code: ERROR_KEYS.llmUnavailable,
        message: LLM_BUDGET_EXHAUSTED_MESSAGE,
      });
    }

    return selected;
  }

  async list(): Promise<LlmRouteView[]> {
    const routes = await this.prisma.llmRoute.findMany({
      orderBy: [{ priority: 'asc' }, { name: 'asc' }],
    });

    return routes.map(toView);
  }

  async get(id: string): Promise<LlmRouteView> {
    return toView(await this.getEntity(id));
  }

  async create(dto: CreateLlmRouteDto, userId: string): Promise<LlmRouteView> {
    const modelName = dto.modelName ?? dto.model;

    if (!modelName) {
      throw new BadRequestException('Укажите model или modelName');
    }

    try {
      const route = await this.prisma.llmRoute.create({
        data: {
          name: dto.name,
          modelName,
          ...(dto.providerType === undefined
            ? {}
            : { providerType: dto.providerType }),
          baseUrl: dto.baseUrl,
          ...(dto.apiKeyEnvVar === undefined
            ? {}
            : { apiKeyEnvVar: dto.apiKeyEnvVar }),
          ...(dto.priority === undefined ? {} : { priority: dto.priority }),
          ...(dto.isActive === undefined ? {} : { isActive: dto.isActive }),
          ...(dto.taskType === undefined ? {} : { taskType: dto.taskType }),
          ...(dto.dailyCostLimit === undefined
            ? {}
            : { dailyCostLimit: dto.dailyCostLimit }),
        },
      });

      await this.auditService.record({
        userId,
        action: 'llm_route.create',
        entityType: 'LlmRoute',
        entityId: route.id,
        metadata: {
          name: route.name,
          modelName: route.modelName,
          providerType: route.providerType,
          baseUrl: route.baseUrl,
          priority: route.priority,
          taskType: route.taskType,
          dailyCostLimit: toNumber(route.dailyCostLimit),
        },
      });

      return toView(route);
    } catch (error) {
      this.rethrowDuplicate(error);
    }
  }

  async update(
    id: string,
    dto: UpdateLlmRouteDto,
    userId: string,
  ): Promise<LlmRouteView> {
    await this.getEntity(id);

    const data: Prisma.LlmRouteUpdateInput = {};

    if (dto.name !== undefined) {
      data.name = dto.name;
    }

    const modelName = dto.modelName ?? dto.model;

    if (modelName !== undefined) {
      data.modelName = modelName;
    }

    if (dto.providerType !== undefined) {
      data.providerType = dto.providerType;
    }

    if (dto.baseUrl !== undefined) {
      data.baseUrl = dto.baseUrl;
    }

    if (dto.apiKeyEnvVar !== undefined) {
      data.apiKeyEnvVar = dto.apiKeyEnvVar;
    }

    if (dto.priority !== undefined) {
      data.priority = dto.priority;
    }

    if (dto.isActive !== undefined) {
      data.isActive = dto.isActive;
    }

    if (dto.taskType !== undefined) {
      data.taskType = dto.taskType;
    }

    if (dto.dailyCostLimit !== undefined) {
      data.dailyCostLimit = dto.dailyCostLimit;
    }

    try {
      const route = await this.prisma.llmRoute.update({
        where: { id },
        data,
      });

      await this.auditService.record({
        userId,
        action: 'llm_route.update',
        entityType: 'LlmRoute',
        entityId: route.id,
        metadata: {
          changes: data,
        } as unknown as Prisma.InputJsonValue,
      });

      return toView(route);
    } catch (error) {
      this.rethrowDuplicate(error);
    }
  }

  async remove(id: string, userId: string): Promise<LlmRouteView> {
    const route = await this.getEntity(id);

    await this.prisma.llmRoute.delete({ where: { id } });

    await this.auditService.record({
      userId,
      action: 'llm_route.delete',
      entityType: 'LlmRoute',
      entityId: route.id,
      metadata: { name: route.name },
    });

    return toView(route);
  }

  private async getEntity(id: string): Promise<LlmRoute> {
    const route = await this.prisma.llmRoute.findUnique({ where: { id } });

    if (!route) {
      throw new NotFoundException(`LLM-маршрут ${id} не найден`);
    }

    return route;
  }

  private rethrowDuplicate(error: unknown): never {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      throw new ConflictException('LLM-маршрут с таким именем уже существует');
    }

    throw error;
  }
}

/** Начало текущих суток в UTC — единая граница дневных бюджетов. */
export function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function toSelection(route: LlmRoute): LlmRouteSelection {
  return {
    id: route.id,
    name: route.name,
    modelName: route.modelName,
    providerType: route.providerType,
    baseUrl: route.baseUrl,
    apiKeyEnvVar: route.apiKeyEnvVar,
    taskType: route.taskType,
    dailyCostLimit: toNumber(route.dailyCostLimit),
  };
}

function toView(route: LlmRoute): LlmRouteView {
  return {
    ...route,
    model: route.modelName,
    dailyCostLimit: toNumber(route.dailyCostLimit),
  };
}

/** Decimal из БД → number для JSON-логов, бюджета и API. */
function toNumber(value: Prisma.Decimal | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  return Number(value.toString());
}
