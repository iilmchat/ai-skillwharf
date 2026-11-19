import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * Ленивая инициализация дефолтной organization/workspace для пользователя
 * (ORG-31.1). Отдельная функция, чтобы AuthService не зависел от
 * WorkspacesModule (иначе возник бы цикл модулей).
 */
export async function ensureDefaultWorkspace(
  prisma: PrismaService,
  userId: string,
  email: string,
): Promise<void> {
  const existing = await prisma.workspaceMember.findFirst({
    where: { userId, workspace: { isDefault: true } },
    select: { id: true },
  });

  if (existing !== null) {
    return;
  }

  const suffix = userId.replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase();
  const base = email.split('@')[0]?.replace(/[^a-z0-9]+/gi, '-').toLowerCase() ?? 'user';
  const slug = `${base || 'user'}-${suffix || 'default'}`.slice(0, 64);

  const organization = await prisma.organization.upsert({
    where: { slug },
    create: { slug, name: `${base || 'User'} organization`, ownerId: userId },
    update: {},
    select: { id: true },
  });

  const workspace = await prisma.workspace.upsert({
    where: {
      organizationId_slug: { organizationId: organization.id, slug: 'default' },
    },
    create: {
      organizationId: organization.id,
      slug: 'default',
      name: 'Основной',
      isDefault: true,
    },
    update: { isDefault: true },
    select: { id: true },
  });

  await prisma.workspaceMember.upsert({
    where: { workspaceId_userId: { workspaceId: workspace.id, userId } },
    create: { workspaceId: workspace.id, userId, role: 'owner' },
    update: { role: 'owner' },
  });
}

/** Дефолтный workspaceId пользователя или null (для старых аккаунтов). */
export async function defaultWorkspaceId(
  prisma: PrismaService,
  userId: string,
): Promise<string | null> {
  const member = await prisma.workspaceMember.findFirst({
    where: { userId, workspace: { isDefault: true } },
    select: { workspaceId: true },
  });

  return member?.workspaceId ?? null;
}
