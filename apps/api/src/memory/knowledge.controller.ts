import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { KnowledgeService } from './knowledge.service.js';
import type {
  KnowledgeDocumentList,
  KnowledgeFolderView,
} from './knowledge.schemas.js';

interface AuthenticatedRequest extends Request {
  user?: { userId: string; email: string; role: string };
}

/** База знаний воркспейса: папки регламентов и проиндексированные чанки (KB-38.1). */
@Controller('knowledge')
@UseGuards(JwtAuthGuard)
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @Get('folders')
  folders(@Req() request: AuthenticatedRequest): Promise<KnowledgeFolderView[]> {
    return this.knowledge.listFolders(this.userId(request));
  }

  @Post('folders')
  createFolder(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<KnowledgeFolderView> {
    return this.knowledge.createFolder(this.userId(request), body);
  }

  @Delete('folders/:id')
  deleteFolder(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<{ id: string }> {
    return this.knowledge.deleteFolder(this.userId(request), id);
  }

  @Get('documents')
  documents(
    @Req() request: AuthenticatedRequest,
    @Query() query: unknown,
  ): Promise<KnowledgeDocumentList> {
    return this.knowledge.listDocuments(this.userId(request), query);
  }

  private userId(request: AuthenticatedRequest): string {
    const userId = request.user?.userId;

    if (userId === undefined || userId === '') {
      throw new UnauthorizedException('Пользователь не аутентифицирован');
    }

    return userId;
  }
}
