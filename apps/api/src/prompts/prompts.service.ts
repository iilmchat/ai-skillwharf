import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  Prisma,
  type PromptExperiment,
  type PromptTemplate,
  type PromptVersion,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_SYSTEM_PROMPT_NAME,
} from './default-prompt.js';
import {
  createExperimentSchema,
  emptyExperimentMetrics,
  experimentStatusSchema,
  experimentMetricsSchema,
  experimentVariantSchema,
  stopExperimentSchema,
  type CreateExperimentInput,
  type ExperimentMetrics,
  type ExperimentVariant,
  type ExperimentView,
  type ResolvedPromptVariant,
  type StopExperimentInput,
} from './prompt-experiment.schemas.js';

export type PromptTemplateWithLatest = Prisma.PromptTemplateGetPayload<{
  include: { versions: true };
}>;

/** Шаблон с номером активной версии для Control Plane UI. */
export type PromptTemplateView = PromptTemplateWithLatest & {
  activeVersion: number | null;
};

@Injectable()
export class PromptsService {
  private readonly logger = new Logger(PromptsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  /** Засевает дефолтный промпт, если его ещё нет в БД. */
  async onModuleInit(): Promise<void> {
    try {
      await this.seedDefaultPrompt();
    } catch (error) {
      // Недоступная БД не должна ронять старт API: LlmService умеет
      // откатываться на DEFAULT_SYSTEM_PROMPT.
      this.logger.error(`Не удалось засеять промпты: ${String(error)}`);
    }
  }

  async seedDefaultPrompt(): Promise<void> {
    const existing = await this.prisma.promptTemplate.findUnique({
      where: { name: DEFAULT_SYSTEM_PROMPT_NAME },
      include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
    });

    if (!existing) {
      await this.prisma.promptTemplate.create({
        data: {
          name: DEFAULT_SYSTEM_PROMPT_NAME,
          description: 'Системная инструкция по умолчанию',
          isActive: true,
          versions: {
            create: { version: 1, content: DEFAULT_SYSTEM_PROMPT },
          },
        },
      });
      return;
    }

    if (existing.versions.length === 0) {
      await this.prisma.promptVersion.create({
        data: {
          templateId: existing.id,
          version: 1,
          content: DEFAULT_SYSTEM_PROMPT,
        },
      });
    }
  }

  /** Список шаблонов вместе с последней версией. */
  async getTemplates(): Promise<PromptTemplateView[]> {
    const templates = await this.prisma.promptTemplate.findMany({
      orderBy: { name: 'asc' },
      include: {
        versions: { orderBy: { version: 'desc' }, take: 1 },
      },
    });

    return templates.map((template) => ({
      ...template,
      activeVersion: template.versions[0]?.version ?? null,
      updatedAt: template.versions[0]?.createdAt ?? template.updatedAt,
    }));
  }

  /** История версий шаблона (свежие сверху). */
  async getVersions(templateId: string): Promise<PromptVersion[]> {
    await this.assertTemplate(templateId);

    return this.prisma.promptVersion.findMany({
      where: { templateId },
      orderBy: { version: 'desc' },
    });
  }

  /** Создаёт новую версию промпта и фиксирует действие в аудите. */
  async createVersion(
    templateId: string,
    content: string,
    userId: string,
  ): Promise<PromptVersion> {
    const template = await this.assertTemplate(templateId);

    const latest = await this.prisma.promptVersion.findFirst({
      where: { templateId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const version = (latest?.version ?? 0) + 1;

    const created = await this.prisma.promptVersion.create({
      data: { templateId, version, content },
    });

    await this.auditService.record({
      userId,
      action: 'prompt.version.create',
      entityType: 'PromptTemplate',
      entityId: template.id,
      metadata: { name: template.name, version },
    });

    return created;
  }

  /**
   * Активная системная инструкция: последняя версия активного шаблона.
   * При отсутствии шаблона или ошибке БД возвращает дефолтный промпт.
   */
  async getActiveSystemPrompt(
    name: string = DEFAULT_SYSTEM_PROMPT_NAME,
    conversationId?: string,
  ): Promise<string> {
    return (await this.resolveSystemPrompt(name, conversationId)).content;
  }

  /**
   * Выбирает системный промпт для запроса. При активном A/B-эксперименте
   * вариант определяется детерминированно по хешу `conversationId`, поэтому
   * один и тот же диалог всегда видит одну версию.
   */
  async resolveSystemPrompt(
    name: string = DEFAULT_SYSTEM_PROMPT_NAME,
    conversationId?: string,
  ): Promise<ResolvedPromptVariant> {
    try {
      const template = await this.prisma.promptTemplate.findFirst({
        where: { name, isActive: true },
        include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
      });

      if (!template) {
        return {
          content: DEFAULT_SYSTEM_PROMPT,
          experimentId: null,
          variant: null,
          versionId: null,
        };
      }

      const experiment = await this.prisma.promptExperiment.findFirst({
        where: { promptId: template.id, status: 'running' },
      });

      if (experiment === null || conversationId === undefined) {
        return {
          content: template.versions[0]?.content ?? DEFAULT_SYSTEM_PROMPT,
          experimentId: null,
          variant: null,
          versionId: null,
        };
      }

      const variant = selectExperimentVariant(
        conversationId,
        experiment.trafficSplitB,
      );
      const versionId =
        variant === 'B'
          ? experiment.variantBVersionId
          : experiment.variantAVersionId;
      const version = await this.prisma.promptVersion.findUnique({
        where: { id: versionId },
        select: { content: true },
      });

      await this.recordExperimentRequest(experiment, variant);

      return {
        content: version?.content ?? template.versions[0]?.content ?? DEFAULT_SYSTEM_PROMPT,
        experimentId: experiment.id,
        variant,
        versionId,
      };
    } catch (error) {
      this.logger.warn(
        `Не удалось прочитать промпт ${name}, используется дефолт: ${String(error)}`,
      );

      return {
        content: DEFAULT_SYSTEM_PROMPT,
        experimentId: null,
        variant: null,
        versionId: null,
      };
    }
  }

  /** Список экспериментов шаблона с усреднёнными метриками. */
  async listExperiments(promptId: string): Promise<ExperimentView[]> {
    await this.assertTemplate(promptId);
    const rows = await this.prisma.promptExperiment.findMany({
      where: { promptId },
      orderBy: { createdAt: 'desc' },
    });

    return rows.map((row) => toExperimentView(row));
  }

  /** Запуск эксперимента: только один `running` на шаблон. */
  async startExperiment(
    promptId: string,
    raw: unknown,
    userId: string,
  ): Promise<ExperimentView> {
    const input: CreateExperimentInput = createExperimentSchema.parse(raw);
    await this.assertTemplate(promptId);

    const running = await this.prisma.promptExperiment.findFirst({
      where: { promptId, status: 'running' },
      select: { id: true },
    });

    if (running !== null) {
      throw new ConflictException(
        `На промпте уже запущен эксперимент ${running.id}`,
      );
    }

    const versions = await this.prisma.promptVersion.findMany({
      where: {
        id: { in: [input.variantAVersionId, input.variantBVersionId] },
      },
      select: { id: true, templateId: true },
    });

    if (
      versions.length !== 2 ||
      versions.some((version) => version.templateId !== promptId)
    ) {
      throw new BadRequestException(
        'Варианты A и B должны быть версиями этого промпта',
      );
    }

    const row = await this.prisma.promptExperiment.create({
      data: {
        promptId,
        name: input.name,
        variantAVersionId: input.variantAVersionId,
        variantBVersionId: input.variantBVersionId,
        trafficSplitB: input.trafficSplitB,
        status: 'running',
        metricsJson: emptyExperimentMetrics() as unknown as Prisma.InputJsonValue,
      },
    });

    await this.auditService.record({
      userId,
      action: 'prompt.experiment.start',
      entityType: 'PromptExperiment',
      entityId: row.id,
      metadata: { promptId, name: input.name, trafficSplitB: input.trafficSplitB },
    });

    return toExperimentView(row);
  }

  /** Остановка с опциональным промоушеном победителя. */
  async stopExperiment(
    experimentId: string,
    raw: unknown,
    userId: string,
  ): Promise<ExperimentView> {
    const input: StopExperimentInput = stopExperimentSchema.parse(raw ?? {});
    const existing = await this.prisma.promptExperiment.findUnique({
      where: { id: experimentId },
    });

    if (existing === null) {
      throw new NotFoundException(`Эксперимент ${experimentId} не найден`);
    }

    if (existing.status !== 'running') {
      throw new ConflictException('Эксперимент уже остановлен');
    }

    if (input.promoteVersionId !== undefined) {
      const version = await this.prisma.promptVersion.findUnique({
        where: { id: input.promoteVersionId },
        select: { templateId: true },
      });

      if (version === null || version.templateId !== existing.promptId) {
        throw new BadRequestException(
          'Победитель должен быть версией того же промпта',
        );
      }
    }

    const row = await this.prisma.promptExperiment.update({
      where: { id: experimentId },
      data: {
        status: input.promoteVersionId === undefined ? 'stopped' : 'completed',
        winnerVersionId: input.promoteVersionId ?? null,
        stoppedAt: new Date(),
      },
    });

    await this.auditService.record({
      userId,
      action: 'prompt.experiment.stop',
      entityType: 'PromptExperiment',
      entityId: row.id,
      metadata: {
        promptId: row.promptId,
        promoted: input.promoteVersionId ?? null,
      },
    });

    return toExperimentView(row);
  }

  /** Фиксирует стоимость и задержку вызова варианта (API-28.1). */
  async recordExperimentUsage(
    experimentId: string,
    variant: ExperimentVariant,
    latencyMs: number,
    cost: number,
  ): Promise<void> {
    const parsedVariant = experimentVariantSchema.parse(variant);
    const parsedLatency = z
      .number()
      .nonnegative()
      .max(600_000)
      .parse(latencyMs);
    const parsedCost = z.number().nonnegative().parse(cost);
    const experiment = await this.prisma.promptExperiment.findUnique({
      where: { id: experimentId },
      select: { status: true, metricsJson: true },
    });

    if (experiment === null || experiment.status !== 'running') {
      return;
    }

    const metrics = readMetrics(experiment.metricsJson);
    const bucket = metrics[parsedVariant];

    bucket.requests += 1;
    bucket.totalLatencyMs += parsedLatency;
    bucket.totalCost += parsedCost;

    await this.prisma.promptExperiment.update({
      where: { id: experimentId },
      data: { metricsJson: metrics as unknown as Prisma.InputJsonValue },
    });
  }

  /** Счётчик запросов: инкремент при каждом выборе варианта. */
  private async recordExperimentRequest(
    experiment: PromptExperiment,
    variant: ExperimentVariant,
  ): Promise<void> {
    const metrics = readMetrics(experiment.metricsJson);
    metrics[variant].requests += 1;

    try {
      await this.prisma.promptExperiment.update({
        where: { id: experiment.id },
        data: { metricsJson: metrics as unknown as Prisma.InputJsonValue },
      });
    } catch (error) {
      this.logger.warn(`Не удалось записать метрику эксперимента: ${String(error)}`);
    }
  }

  private async assertTemplate(
    templateId: string,
  ): Promise<Pick<PromptTemplate, 'id' | 'name'>> {
    const template = await this.prisma.promptTemplate.findUnique({
      where: { id: templateId },
      select: { id: true, name: true },
    });

    if (!template) {
      throw new NotFoundException(`Промпт ${templateId} не найден`);
    }

    return template;
  }
}

/** Детерминированный выбор варианта: SHA-256 conversationId → 0..99. */
export function selectExperimentVariant(
  conversationId: string,
  trafficSplitB: number,
): ExperimentVariant {
  const split = z.number().int().min(0).max(100).parse(trafficSplitB);
  const bucket =
    createHash('sha256').update(conversationId).digest().readUInt32BE(0) % 100;

  return bucket < split ? 'B' : 'A';
}

/** Читает metricsJson, устойчиво к битым/отсутствующим данным. */
function readMetrics(raw: Prisma.JsonValue | null): ExperimentMetrics {
  const parsed = experimentMetricsSchema.safeParse(raw ?? {});

  return parsed.success ? parsed.data : emptyExperimentMetrics();
}

/** Метрики варианта со средними значениями. */
function variantView(metrics: ExperimentMetrics, variant: ExperimentVariant) {
  const bucket = metrics[variant];

  return {
    requests: bucket.requests,
    avgLatencyMs:
      bucket.requests === 0 ? 0 : Math.round(bucket.totalLatencyMs / bucket.requests),
    avgCost:
      bucket.requests === 0
        ? 0
        : Math.round((bucket.totalCost / bucket.requests) * 100) / 100,
  };
}

function toExperimentView(row: PromptExperiment): ExperimentView {
  const metrics = readMetrics(row.metricsJson);

  return {
    id: row.id,
    promptId: row.promptId,
    name: row.name,
    variantAVersionId: row.variantAVersionId,
    variantBVersionId: row.variantBVersionId,
    trafficSplitB: row.trafficSplitB,
    status: experimentStatusSchema.parse(row.status),
    winnerVersionId: row.winnerVersionId,
    metrics: {
      A: variantView(metrics, 'A'),
      B: variantView(metrics, 'B'),
    },
    createdAt: row.createdAt.toISOString(),
    stoppedAt: row.stoppedAt?.toISOString() ?? null,
  };
}
