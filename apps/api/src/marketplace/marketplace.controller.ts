import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import {
  WorkspaceContextGuard,
  workspaceFromRequest,
} from '../workspaces/workspace-context.guard.js';
import {
  MarketplaceService,
  type InstallMarketplaceResult,
  type MarketplaceListResult,
  type MarketplaceSkillView,
} from './marketplace.service.js';

interface AuthenticatedUser {
  userId: string;
}

interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}

/**
 * Публичный каталог навыков (API-27.2). Все эндпоинты требуют
 * аутентификации, но не административных прав: автор публикует свой навык,
 * пользователь — устанавливает в 1 клик.
 */
@Controller('marketplace/skills')
@UseGuards(JwtAuthGuard, WorkspaceContextGuard)
export class MarketplaceController {
  constructor(private readonly marketplace: MarketplaceService) {}

  @Get()
  list(@Req() request: AuthenticatedRequest): Promise<MarketplaceListResult> {
    // Query валидируется Zod внутри сервиса: внешние данные не доверяются.
    // userId из JWT нужен для флага installed в выдаче каталога (KI-086).
    return this.marketplace.listSkills(
      request.query,
      this.userId(request),
      workspaceFromRequest(request)?.workspaceId,
    );
  }

  @Post()
  publish(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<MarketplaceSkillView> {
    return this.marketplace.publish(this.userId(request), body);
  }

  @Post(':slug/install')
  install(
    @Req() request: AuthenticatedRequest,
    @Param('slug') slug: string,
  ): Promise<InstallMarketplaceResult> {
    return this.marketplace.install(
      this.userId(request),
      slug,
      workspaceFromRequest(request)?.workspaceId,
    );
  }

  private userId(request: AuthenticatedRequest): string {
    const id = request.user?.userId;

    if (id === undefined || id === '') {
      throw new Error('Не удалось определить пользователя запроса');
    }

    return id;
  }
}
