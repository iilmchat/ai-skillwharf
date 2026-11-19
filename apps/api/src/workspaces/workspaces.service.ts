import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  hitlLimitExceededError,
  insufficientWorkspaceRoleError,
} from '../common/api-error.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  addWorkspaceMemberSchema,
  createWorkspaceSchema,
  slugSchema,
  updateWorkspaceMemberSchema,
  workspaceHeaderSchema,
  workspaceMemberViewSchema,
  workspaceRoleSchema,
  workspaceViewSchema,
  type WorkspaceMemberView,
  type WorkspaceRole,
  type WorkspaceView,
} from './workspace.schemas.js';
import { ensureDefaultWorkspace } from './workspace-defaults.js';

/** Роли, которые имеют право управлять участниками и ключами. */
const MANAGER_ROLES: ReadonlySet<WorkspaceRole> = new Set(['owner', 'admin']);
/** Роли, которые могут одобрять HITL и запускать платные инструменты. */
const PAYING_ROLES: ReadonlySet<WorkspaceRole> = new Set([
  'owner',
  'admin',
  'operator',
]);

export interface ActiveWorkspace {
  readonly workspaceId: string;
  readonly role: WorkspaceRole;
  readonly hitlApprovalLimitRub: number | null;
}

/**
 * Управление мульти-тенантной иерархией и доступом (ORG-31.1/31.2).
 * Без заголовка X-Workspace-Id используется дефолтный воркспейс — это
 * сохраняет полную совместимость со старыми клиентами и тестами.
 */
@Injectable()
export class WorkspacesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Автосоздание дефолтной структуры (вызывается и при регистрации). */
  async ensureForUser(userId: string, email: string): Promise<void> {
    await ensureDefaultWorkspace(this.prisma, userId, email);
  }

  /** Список воркспейсов пользователя с его ролью и лимитом. */
  async listForUser(userId: string, email: string): Promise<WorkspaceView[]> {
    await this.ensureForUser(userId, email);
    const members = await this.prisma.workspaceMember.findMany({
      where: { userId },
      include: { workspace: true },
      orderBy: { workspace: { createdAt: 'asc' } },
    });

    return members.map((member) =>
      workspaceViewSchema.parse({
        id: member.workspace.id,
        organizationId: member.workspace.organizationId,
        name: member.workspace.name,
        slug: member.workspace.slug,
        isDefault: member.workspace.isDefault,
        role: workspaceRoleSchema.parse(member.role),
        hitlApprovalLimitRub:
          member.hitlApprovalLimitRub?.toFixed(2) ?? null,
      }),
    );
  }

  /** Создание воркспейса в первой организации, где пользователь — owner. */
  async create(userId: string, raw: unknown): Promise<WorkspaceView> {
    const input = createWorkspaceSchema.parse(raw ?? {});
    const organization = await this.prisma.organization.findFirst({
      where: { ownerId: userId },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });

    if (organization === null) {
      throw new NotFoundException('Организация пользователя не найдена');
    }

    const slug =
      input.slug ??
      input.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 64);

    const workspace = await this.prisma.workspace.create({
      data: {
        organizationId: organization.id,
        name: input.name,
        slug: slugSchema.parse(slug),
      },
    });

    await this.prisma.workspaceMember.create({
      data: { workspaceId: workspace.id, userId, role: 'owner' },
    });

    return workspaceViewSchema.parse({
      ...workspace,
      role: 'owner',
      hitlApprovalLimitRub: null,
    });
  }

  /**
   * Разрешает активный воркспейс: явный X-Workspace-Id (с проверкой членства)
   * или дефолтный воркспейс пользователя.
   */
  async resolveActive(
    userId: string,
    header: unknown,
  ): Promise<ActiveWorkspace | null> {
    const parsed = workspaceHeaderSchema.safeParse(
      typeof header === 'string' && header.trim() === '' ? undefined : header,
    );

    if (!parsed.success) {
      throw new ForbiddenException('Некорректный X-Workspace-Id');
    }

    const member = await this.prisma.workspaceMember.findFirst({
      where: parsed.data === undefined
        ? { userId, workspace: { isDefault: true } }
        : { userId, workspaceId: parsed.data },
      select: {
        workspaceId: true,
        role: true,
        hitlApprovalLimitRub: true,
      },
    });

    if (member === null) {
      if (parsed.data !== undefined) {
        throw new ForbiddenException('Нет доступа к воркспейсу');
      }

      return null; // легаси-пользователь без воркспейса — работает как раньше
    }

    return {
      workspaceId: member.workspaceId,
      role: workspaceRoleSchema.parse(member.role),
      hitlApprovalLimitRub: member.hitlApprovalLimitRub?.toNumber() ?? null,
    };
  }

  /** Требует одну из ролей; viewer блокирует платные/админские действия. */
  async assertRole(
    userId: string,
    allowed: ReadonlySet<WorkspaceRole>,
    header?: unknown,
  ): Promise<void> {
    const active = await this.resolveActive(userId, header);

    if (active !== null && !allowed.has(active.role)) {
      throw insufficientWorkspaceRoleError(
        `Роль ${active.role} не разрешает это действие`,
      );
    }
  }

  /** Проверка ABAC-лимита HITL-одобрения (сумма в ₽). */
  async assertHitlLimit(
    userId: string,
    amountRub: number,
    header?: unknown,
  ): Promise<void> {
    const active = await this.resolveActive(userId, header);

    if (
      active !== null &&
      active.hitlApprovalLimitRub !== null &&
      amountRub > active.hitlApprovalLimitRub
    ) {
      throw hitlLimitExceededError(
        `Сумма ${amountRub} ₽ превышает лимит одобрения ${active.hitlApprovalLimitRub} ₽`,
      );
    }
  }

  /** Роли, которые могут запускать платные инструменты. */
  payingRoles(): ReadonlySet<WorkspaceRole> {
    return PAYING_ROLES;
  }

  /** Роли, которые могут управлять участниками. */
  managerRoles(): ReadonlySet<WorkspaceRole> {
    return MANAGER_ROLES;
  }

  async listMembers(
    requesterId: string,
    workspaceId: string,
  ): Promise<WorkspaceMemberView[]> {
    await this.assertMembership(requesterId, workspaceId);
    const members = await this.prisma.workspaceMember.findMany({
      where: { workspaceId },
      include: { user: { select: { email: true } } },
      orderBy: { createdAt: 'asc' },
    });

    return members.map((member) =>
      workspaceMemberViewSchema.parse({
        id: member.id,
        workspaceId: member.workspaceId,
        userId: member.userId,
        email: member.user.email,
        role: workspaceRoleSchema.parse(member.role),
        hitlApprovalLimitRub:
          member.hitlApprovalLimitRub?.toFixed(2) ?? null,
        createdAt: member.createdAt.toISOString(),
      }),
    );
  }

  /** Добавление участника по email (только owner/admin). */
  async addMember(
    requesterId: string,
    workspaceId: string,
    raw: unknown,
  ): Promise<WorkspaceMemberView> {
    await this.assertManager(requesterId, workspaceId);
    const input = addWorkspaceMemberSchema.parse(raw ?? {});
    const user = await this.prisma.user.findUnique({
      where: { email: input.email },
      select: { id: true, email: true },
    });

    if (user === null) {
      throw new NotFoundException('Пользователь с таким email не найден');
    }

    const member = await this.prisma.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId, userId: user.id } },
      create: {
        workspaceId,
        userId: user.id,
        role: input.role,
        ...(input.hitlApprovalLimitRub === undefined
          ? {}
          : { hitlApprovalLimitRub: new Prisma.Decimal(input.hitlApprovalLimitRub) }),
      },
      update: {
        role: input.role,
        ...(input.hitlApprovalLimitRub === undefined
          ? {}
          : { hitlApprovalLimitRub: new Prisma.Decimal(input.hitlApprovalLimitRub) }),
      },
      include: { user: { select: { email: true } } },
    });

    return workspaceMemberViewSchema.parse({
      id: member.id,
      workspaceId: member.workspaceId,
      userId: member.userId,
      email: member.user.email,
      role: workspaceRoleSchema.parse(member.role),
      hitlApprovalLimitRub: member.hitlApprovalLimitRub?.toFixed(2) ?? null,
      createdAt: member.createdAt.toISOString(),
    });
  }

  /** Изменение роли/лимита участника (только owner/admin). */
  async updateMember(
    requesterId: string,
    workspaceId: string,
    memberId: string,
    raw: unknown,
  ): Promise<WorkspaceMemberView> {
    await this.assertManager(requesterId, workspaceId);
    const input = updateWorkspaceMemberSchema.parse(raw ?? {});
    const existing = await this.prisma.workspaceMember.findFirst({
      where: { id: memberId, workspaceId },
      select: { id: true },
    });

    if (existing === null) {
      throw new NotFoundException('Участник воркспейса не найден');
    }

    const member = await this.prisma.workspaceMember.update({
      where: { id: memberId },
      data: {
        ...(input.role === undefined ? {} : { role: input.role }),
        ...(input.hitlApprovalLimitRub === undefined
          ? {}
          : {
              hitlApprovalLimitRub:
                input.hitlApprovalLimitRub === null
                  ? null
                  : new Prisma.Decimal(input.hitlApprovalLimitRub),
            }),
      },
      include: { user: { select: { email: true } } },
    });

    return workspaceMemberViewSchema.parse({
      id: member.id,
      workspaceId: member.workspaceId,
      userId: member.userId,
      email: member.user.email,
      role: workspaceRoleSchema.parse(member.role),
      hitlApprovalLimitRub: member.hitlApprovalLimitRub?.toFixed(2) ?? null,
      createdAt: member.createdAt.toISOString(),
    });
  }

  private async assertMembership(
    userId: string,
    workspaceId: string,
  ): Promise<void> {
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { id: true },
    });

    if (member === null) {
      throw new ForbiddenException('Нет доступа к воркспейсу');
    }
  }

  private async assertManager(
    requesterId: string,
    workspaceId: string,
  ): Promise<void> {
    await this.assertMembership(requesterId, workspaceId);
    const member = await this.prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: requesterId } },
      select: { role: true },
    });

    if (member === null || !MANAGER_ROLES.has(workspaceRoleSchema.parse(member.role))) {
      throw insufficientWorkspaceRoleError(
        'Управление участниками доступно только owner/admin',
      );
    }
  }
}

