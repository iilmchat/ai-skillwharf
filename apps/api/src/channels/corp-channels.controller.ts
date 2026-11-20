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
import { CorpChannelsService } from './corp-channels.service.js';
import type {
  CorpChannelView,
  CreatedCorpChannel,
} from './corp-channels.schemas.js';

interface AuthenticatedRequest extends Request {
  user?: { userId: string; email: string; role: string };
}

/** Подключения корпоративных мессенджеров (OMNI-40.1/40.2). */
@Controller('workspaces/:workspaceId/channels/corporate')
@UseGuards(JwtAuthGuard, WorkspaceContextGuard)
export class CorpChannelsController {
  constructor(private readonly channels: CorpChannelsService) {}

  @Get()
  list(
    @Req() request: AuthenticatedRequest,
    @Param('workspaceId') workspaceId: string,
  ): Promise<CorpChannelView[]> {
    return this.channels.list(this.userId(request), workspaceId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Req() request: AuthenticatedRequest,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
  ): Promise<CreatedCorpChannel> {
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
