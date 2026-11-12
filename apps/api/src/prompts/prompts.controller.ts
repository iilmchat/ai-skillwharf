import {
  Body,
  Controller,
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
import type { PromptVersion } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { CreatePromptVersionDto } from './dto/create-prompt-version.dto.js';
import { PromptsService, type PromptTemplateView } from './prompts.service.js';

interface AuthenticatedRequest extends Request {
  user?: { userId: string; email: string; role: string };
}

@Controller('prompts')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin', 'owner')
export class PromptsController {
  constructor(private readonly promptsService: PromptsService) {}

  @Get()
  list(): Promise<PromptTemplateView[]> {
    return this.promptsService.getTemplates();
  }

  @Get(':id/versions')
  versions(@Param('id') id: string): Promise<PromptVersion[]> {
    return this.promptsService.getVersions(id);
  }

  @Post(':id/versions')
  @HttpCode(HttpStatus.CREATED)
  createVersion(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: CreatePromptVersionDto,
  ): Promise<PromptVersion> {
    const userId = request.user?.userId;

    if (!userId) {
      throw new UnauthorizedException('Пользователь не аутентифицирован');
    }

    return this.promptsService.createVersion(id, dto.content, userId);
  }
}
