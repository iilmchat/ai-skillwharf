import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { ChatService } from './chat.service.js';
import { CreateConversationDto } from './dto/create-conversation.dto.js';
import {
  pendingApprovalListSchema,
  type PendingApprovalList,
} from './dto/pending-approval.dto.js';

interface AuthenticatedRequest extends Request {
  user?: { userId: string; email: string; role: string };
}

@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post('conversations')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  createConversation(
    @Req() request: AuthenticatedRequest,
    @Body() dto: CreateConversationDto,
  ): Promise<{ id: string }> {
    const userId = request.user?.userId;

    if (!userId) {
      throw new UnauthorizedException('Пользователь не аутентифицирован');
    }

    return this.chatService.createConversation(userId, dto.title);
  }

  /** Удаляет всю долговременную память текущего пользователя (GDPR/152-ФЗ). */
  @Delete('memory')
  @UseGuards(JwtAuthGuard)
  async clearMemory(
    @Req() request: AuthenticatedRequest,
  ): Promise<{ deleted: number }> {
    const userId = request.user?.userId;

    if (!userId) {
      throw new UnauthorizedException('Пользователь не аутентифицирован');
    }

    return this.chatService.clearMemory(userId);
  }

  /**
   * Диалоги пользователя, ожидающие `approve_action`. Состояние читается из
   * PostgreSQL, поэтому список переживает рестарт API.
   */
  @Get('pending')
  @UseGuards(JwtAuthGuard)
  async listPendingApprovals(
    @Req() request: AuthenticatedRequest,
  ): Promise<PendingApprovalList> {
    const userId = request.user?.userId;

    if (!userId) {
      throw new UnauthorizedException('Пользователь не аутентифицирован');
    }

    const items = await this.chatService.listPendingApprovals(userId);

    return pendingApprovalListSchema.parse({ items });
  }
}
