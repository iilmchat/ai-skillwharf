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
import { WorkspaceContextGuard } from '../workspaces/workspace-context.guard.js';
import { TelegramChannelsService } from './telegram-channels.service.js';
import type {
  CreatedTelegramChannel,
  TelegramChannelView,
} from './telegram-channels.schemas.js';

interface AuthenticatedRequest extends Request {
  user?: { userId: string; email: string; role: string };
}

/** Подключение Telegram-ботов к воркспейсу (OMNI-39.1). */
@Controller('workspaces/:workspaceId/channels/telegram')
@UseGuards(JwtAuthGuard, WorkspaceContextGuard)
export class TelegramChannelsController {
  constructor(private readonly channels: TelegramChannelsService) {}

  @Get()
  list(
    @Req() request: AuthenticatedRequest,
    @Param('workspaceId') workspaceId: string,
  ): Promise<TelegramChannelView[]> {
    return this.channels.list(this.userId(request), workspaceId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Req() request: AuthenticatedRequest,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
  ): Promise<CreatedTelegramChannel> {
    return this.channels.create(this.userId(request), workspaceId, body);
  }

  @Delete(':channelId')
  remove(
    @Req() request: AuthenticatedRequest,
    @Param('workspaceId') workspaceId: string,
    @Param('channelId') channelId: string,
  ): Promise<{ id: string }> {
    return this.channels.remove(this.userId(request), workspaceId, channelId);
  }

  private userId(request: AuthenticatedRequest): string {
    const userId = request.user?.userId;

    if (userId === undefined || userId === '') {
      throw new UnauthorizedException('Пользователь не аутентифицирован');
    }

    return userId;
  }
}
