import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  Prisma,
  type PromptTemplate,
  type PromptVersion,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_SYSTEM_PROMPT_NAME,
} from './default-prompt.js';

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
  ): Promise<string> {
    try {
      const template = await this.prisma.promptTemplate.findFirst({
        where: { name, isActive: true },
        include: {
          versions: { orderBy: { version: 'desc' }, take: 1 },
        },
      });

      return template?.versions[0]?.content ?? DEFAULT_SYSTEM_PROMPT;
    } catch (error) {
      this.logger.warn(
        `Не удалось прочитать промпт ${name}, используется дефолт: ${String(error)}`,
      );

      return DEFAULT_SYSTEM_PROMPT;
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
