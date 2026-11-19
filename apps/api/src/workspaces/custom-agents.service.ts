import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { invalidRequestError } from '../common/api-error.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { WorkspaceRole } from './workspace.schemas.js';
import {
  createCustomAgentRoleSchema,
  customAgentRoleContextSchema,
  customAgentRoleViewSchema,
  updateCustomAgentRoleSchema,
  type CustomAgentRoleContext,
  type CustomAgentRoleView,
} from './custom-agents.schemas.js';
import { WorkspacesService } from './workspaces.service.js';

const MANAGER_ROLES: ReadonlySet<WorkspaceRole> = new Set(['owner', 'admin']);
const MEMBER_ROLES: ReadonlySet<WorkspaceRole> = new Set([
  'owner',
  'admin',
  'operator',
  'viewer',
]);

function toView(row: {
  id: string;
  workspaceId: string;
  name: string;
  roleKey: string;
  description: string | null;
  systemPrompt: string;
  skillSlugs: string[];
  hitlPolicy: string;
  dailyBudgetRub: Prisma.Decimal | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}): CustomAgentRoleView {
  return customAgentRoleViewSchema.parse({
    ...row,
    dailyBudgetRub: row.dailyBudgetRub?.toFixed(2) ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

/**
 * Конструктор кастомных ролей агентов AI-Офиса (BUILDER-35.1/35.2/35.3).
 * Чтение доступно всем участникам, изменение — owner/admin воркспейса.
 */
@Injectable()
export class CustomAgentRolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaces: WorkspacesService,
  ) {}

  async list(
    userId: string,
    workspaceId: string,
  ): Promise<CustomAgentRoleView[]> {
    await this.workspaces.assertRole(userId, MEMBER_ROLES, workspaceId);
    const rows = await this.prisma.customAgentRole.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
    });

    return rows.map(toView);
  }

  async create(
    userId: string,
    workspaceId: string,
    body: unknown,
  ): Promise<CustomAgentRoleView> {
    await this.assertManager(userId, workspaceId);
    const input = createCustomAgentRoleSchema.parse(body);

    await this.assertUniqueKey(workspaceId, input.roleKey);

    const row = await this.prisma.customAgentRole.create({
      data: {
        workspaceId,
        name: input.name,
        roleKey: input.roleKey,
        description: input.description ?? null,
        systemPrompt: input.systemPrompt,
        skillSlugs: input.skillSlugs,
        hitlPolicy: input.hitlPolicy,
        dailyBudgetRub: input.dailyBudgetRub ?? null,
        isActive: input.isActive,
      },
    });

    return toView(row);
  }

  async update(
    userId: string,
    workspaceId: string,
    agentId: string,
    body: unknown,
  ): Promise<CustomAgentRoleView> {
    await this.assertManager(userId, workspaceId);
    const input = updateCustomAgentRoleSchema.parse(body);
    const current = await this.findInWorkspace(workspaceId, agentId);

    if (input.roleKey !== undefined && input.roleKey !== current.roleKey) {
      await this.assertUniqueKey(workspaceId, input.roleKey);
    }

    const row = await this.prisma.customAgentRole.update({
      where: { id: agentId },
      data: {
        ...input,
        ...(input.dailyBudgetRub !== undefined
          ? { dailyBudgetRub: input.dailyBudgetRub }
          : {}),
      },
    });

    return toView(row);
  }

  async remove(
    userId: string,
    workspaceId: string,
    agentId: string,
  ): Promise<{ id: string }> {
    await this.assertManager(userId, workspaceId);
    await this.findInWorkspace(workspaceId, agentId);
    await this.prisma.customAgentRole.delete({ where: { id: agentId } });

    return { id: agentId };
  }

  /** Активные роли воркспейса для обогащения контекста ChatService. */
  async findActiveContext(
    workspaceId: string,
  ): Promise<CustomAgentRoleContext[]> {
    const rows = await this.prisma.customAgentRole.findMany({
      where: { workspaceId, isActive: true },
      select: {
        roleKey: true,
        name: true,
        systemPrompt: true,
        skillSlugs: true,
        hitlPolicy: true,
        dailyBudgetRub: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    return z.array(customAgentRoleContextSchema).parse(
      rows.map((row) => ({
        ...row,
        dailyBudgetRub: row.dailyBudgetRub?.toNumber() ?? null,
      })),
    );
  }

  private async assertManager(
    userId: string,
    workspaceId: string,
  ): Promise<void> {
    await this.workspaces.assertRole(userId, MANAGER_ROLES, workspaceId);
  }

  private async assertUniqueKey(
    workspaceId: string,
    roleKey: string,
  ): Promise<void> {
    const existing = await this.prisma.customAgentRole.findUnique({
      where: { workspaceId_roleKey: { workspaceId, roleKey } },
    });

    if (existing !== null) {
      throw invalidRequestError(
        `Роль с roleKey «${roleKey}» уже существует в воркспейсе`,
      );
    }
  }

  private async findInWorkspace(workspaceId: string, agentId: string) {
    const row = await this.prisma.customAgentRole.findFirst({
      where: { id: agentId, workspaceId },
    });

    if (row === null) {
      throw new NotFoundException('Кастомная роль агента не найдена');
    }

    return row;
  }
}
