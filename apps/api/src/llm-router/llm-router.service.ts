import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, type LlmRoute } from '@prisma/client';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateLlmRouteDto } from './dto/create-llm-route.dto.js';
import { UpdateLlmRouteDto } from './dto/update-llm-route.dto.js';

/** Параметры выбранного маршрута; ключ API остаётся в env. */
export interface LlmRouteSelection {
  id: string;
  name: string;
  modelName: string;
  baseUrl: string;
  apiKeyEnvVar: string | null;
}

/** Маршрут с алиасом `model` для Control Plane UI. */
export type LlmRouteView = LlmRoute & { model: string };

@Injectable()
export class LlmRouterService {
  private readonly logger = new Logger(LlmRouterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Выбирает активный маршрут с наименьшим priority. Если маршрутов нет
   * или БД недоступна, возвращает `null` — ChatService использует env-fallback.
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

      return {
        id: route.id,
        name: route.name,
        modelName: route.modelName,
        baseUrl: route.baseUrl,
        apiKeyEnvVar: route.apiKeyEnvVar,
      };
    } catch (error) {
      this.logger.warn(
        `Не удалось выбрать LLM-маршрут, используется env-fallback: ${String(error)}`,
      );

      return null;
    }
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
          baseUrl: dto.baseUrl,
          ...(dto.apiKeyEnvVar === undefined
            ? {}
            : { apiKeyEnvVar: dto.apiKeyEnvVar }),
          ...(dto.priority === undefined ? {} : { priority: dto.priority }),
          ...(dto.isActive === undefined ? {} : { isActive: dto.isActive }),
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
          baseUrl: route.baseUrl,
          priority: route.priority,
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
        metadata: { changes: data } as unknown as Prisma.InputJsonValue,
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

function toView(route: LlmRoute): LlmRouteView {
  return { ...route, model: route.modelName };
}
