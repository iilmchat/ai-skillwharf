import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { CreateLlmRouteDto } from './dto/create-llm-route.dto.js';
import { UpdateLlmRouteDto } from './dto/update-llm-route.dto.js';
import { LlmRouterService, type LlmRouteView } from './llm-router.service.js';

interface AuthenticatedRequest extends Request {
  user?: { userId: string; email: string; role: string };
}

@Controller('admin/llm-routes')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin', 'owner')
export class LlmRouterController {
  constructor(private readonly llmRouterService: LlmRouterService) {}

  @Get()
  list(): Promise<LlmRouteView[]> {
    return this.llmRouterService.list();
  }

  @Get(':id')
  get(@Param('id') id: string): Promise<LlmRouteView> {
    return this.llmRouterService.get(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Req() request: AuthenticatedRequest,
    @Body() dto: CreateLlmRouteDto,
  ): Promise<LlmRouteView> {
    return this.llmRouterService.create(dto, userIdOf(request));
  }

  @Patch(':id')
  update(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: UpdateLlmRouteDto,
  ): Promise<LlmRouteView> {
    return this.llmRouterService.update(id, dto, userIdOf(request));
  }

  @Delete(':id')
  remove(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<LlmRouteView> {
    return this.llmRouterService.remove(id, userIdOf(request));
  }
}

function userIdOf(request: AuthenticatedRequest): string {
  const userId = request.user?.userId;

  if (!userId) {
    throw new UnauthorizedException('Пользователь не аутентифицирован');
  }

  return userId;
}
