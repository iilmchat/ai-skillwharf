import {
  Body,
  Controller,
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
import type { WorkspaceMemberView, WorkspaceView } from './workspace.schemas.js';
import { WorkspacesService } from './workspaces.service.js';

interface AuthenticatedRequest extends Request {
  user?: { userId: string; email: string; role: string };
}

@Controller('workspaces')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('user', 'admin', 'owner')
export class WorkspacesController {
  constructor(private readonly workspaces: WorkspacesService) {}

  @Get()
  list(@Req() request: AuthenticatedRequest): Promise<WorkspaceView[]> {
    const { userId, email } = this.identity(request);

    return this.workspaces.listForUser(userId, email);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<WorkspaceView> {
    return this.workspaces.create(this.identity(request).userId, body);
  }

  @Get(':id/members')
  members(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<WorkspaceMemberView[]> {
    return this.workspaces.listMembers(this.identity(request).userId, id);
  }

  @Post(':id/members')
  @HttpCode(HttpStatus.CREATED)
  addMember(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<WorkspaceMemberView> {
    return this.workspaces.addMember(this.identity(request).userId, id, body);
  }

  @Patch(':id/members/:memberId')
  updateMember(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('memberId') memberId: string,
    @Body() body: unknown,
  ): Promise<WorkspaceMemberView> {
    return this.workspaces.updateMember(
      this.identity(request).userId,
      id,
      memberId,
      body,
    );
  }

  private identity(request: AuthenticatedRequest): {
    userId: string;
    email: string;
  } {
    const user = request.user;

    if (user === undefined || user.userId === '' || user.email === '') {
      throw new UnauthorizedException('Пользователь не аутентифицирован');
    }

    return { userId: user.userId, email: user.email };
  }
}
