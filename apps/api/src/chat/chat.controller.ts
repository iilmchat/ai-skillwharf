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
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
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

@ApiTags('Chat')
@ApiBearerAuth()
@Controller('chat')
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post('conversations')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Создать диалог' })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Диалог создан, возвращён его id.',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'JWT отсутствует или недействителен.',
  })
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
  @ApiOperation({ summary: 'Удалить долговременную память пользователя' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Количество удалённых записей памяти.',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'JWT отсутствует или недействителен.',
  })
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
  @ApiOperation({ summary: 'Диалоги, ожидающие подтверждения действия' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Список ожидающих HITL-подтверждений.',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'JWT отсутствует или недействителен.',
  })
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
