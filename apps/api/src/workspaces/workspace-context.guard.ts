import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { WorkspacesService, type ActiveWorkspace } from './workspaces.service.js';

interface WorkspaceRequest extends Request {
  workspace?: ActiveWorkspace | null;
}

/**
 * Извлекает активный воркспейс из заголовка `X-Workspace-Id` и кладёт его в
 * request. Без заголовка (или для легаси-пользователя) — `null`, что
 * сохраняет прежнее поведение без воркспейсов.
 */
@Injectable()
export class WorkspaceContextGuard implements CanActivate {
  constructor(private readonly workspaces: WorkspacesService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<WorkspaceRequest>();
    const user = request.user as { userId?: string } | undefined;

    if (user?.userId === undefined) {
      request.workspace = null;
      return true;
    }

    request.workspace = await this.workspaces.resolveActive(
      user.userId,
      request.header('x-workspace-id'),
    );

    return true;
  }
}

/** Хелпер для сервисов: активный воркспейс из запроса. */
export function workspaceFromRequest(
  request: unknown,
): ActiveWorkspace | null | undefined {
  if (request === null || typeof request !== 'object' || !('workspace' in request)) {
    return undefined;
  }

  const value = (request as WorkspaceRequest).workspace;

  return value === null || value === undefined ? value : value;
}
