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
import type { CustomAgentRoleView } from './custom-agents.schemas.js';
import { CustomAgentRolesService } from './custom-agents.service.js';

interface AuthenticatedRequest extends Request {
  user?: { userId: string; email: string; role: string };
}

/** Конструктор кастомных ролей агентов (BUILDER-35.1/35.2/35.3). */
@Controller('workspaces/:workspaceId/agents')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('user', 'admin', 'owner')
export class CustomAgentRolesController {
  constructor(private readonly roles: CustomAgentRolesService) {}

  @Get()
  list(
    @Req() request: AuthenticatedRequest,
    @Param('workspaceId') workspaceId: string,
  ): Promise<CustomAgentRoleView[]> {
    return this.roles.list(this.identity(request), workspaceId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Req() request: AuthenticatedRequest,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
  ): Promise<CustomAgentRoleView> {
    return this.roles.create(this.identity(request), workspaceId, body);
  }

  @Patch(':agentId')
  update(
    @Req() request: AuthenticatedRequest,
    @Param('workspaceId') workspaceId: string,
    @Param('agentId') agentId: string,
    @Body() body: unknown,
  ): Promise<CustomAgentRoleView> {
    return this.roles.update(this.identity(request), workspaceId, agentId, body);
  }

  @Delete(':agentId')
  @HttpCode(HttpStatus.OK)
  remove(
    @Req() request: AuthenticatedRequest,
    @Param('workspaceId') workspaceId: string,
    @Param('agentId') agentId: string,
  ): Promise<{ id: string }> {
    return this.roles.remove(this.identity(request), workspaceId, agentId);
  }

  private identity(request: AuthenticatedRequest): string {
    const userId = request.user?.userId;

    if (userId === undefined || userId === '') {
      throw new UnauthorizedException('Пользователь не аутентифицирован');
    }

    return userId;
  }
}
