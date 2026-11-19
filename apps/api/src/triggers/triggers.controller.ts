import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { invalidRequestError } from '../common/api-error.js';
import {
  WorkspaceContextGuard,
  workspaceFromRequest,
} from '../workspaces/workspace-context.guard.js';
import type { CreatedTriggerView, TriggerView } from './trigger.schemas.js';
import {
  TriggersService,
  type TriggerReceiveResult,
} from './triggers.service.js';

interface AuthenticatedRequest extends Request {
  user?: { userId: string; email: string; role: string };
}

/** CRUD триггеров и публичный приём webhook-событий (CONNECT-32.2). */
@Controller()
export class TriggersController {
  constructor(private readonly triggers: TriggersService) {}

  @Get('triggers')
  @UseGuards(JwtAuthGuard, WorkspaceContextGuard)
  list(@Req() request: AuthenticatedRequest): Promise<TriggerView[]> {
    return this.triggers.list(workspaceFromRequest(request)?.workspaceId);
  }

  @Post('triggers')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(JwtAuthGuard, WorkspaceContextGuard)
  create(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<CreatedTriggerView> {
    const active = workspaceFromRequest(request);

    if (active === null || active === undefined) {
      throw invalidRequestError('Активный воркспейс не определён');
    }

    const userId = request.user?.userId;

    if (userId === undefined || userId === '') {
      throw new UnauthorizedException('Пользователь не аутентифицирован');
    }

    return this.triggers.create(userId, active.workspaceId, body);
  }

  @Delete('triggers/:id')
  @UseGuards(JwtAuthGuard, WorkspaceContextGuard)
  remove(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<{ deleted: boolean }> {
    return this.triggers.remove(id, workspaceFromRequest(request)?.workspaceId);
  }

  /** Публичный эндпоинт: без JWT, доступ по X-Trigger-Secret. */
  @Post('webhooks/triggers/:slug')
  @HttpCode(HttpStatus.OK)
  receive(
    @Param('slug') slug: string,
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<TriggerReceiveResult> {
    return this.triggers.receive(slug, request.header('x-trigger-secret'), body);
  }
}
