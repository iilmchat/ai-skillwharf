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
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import type { Request } from 'express';
import { ScheduledJobsService } from './scheduled-jobs.service.js';
import type { JobRunResult, ScheduledJobView } from './schedule.schemas.js';

interface AuthenticatedRequest extends Request {
  user?: { userId: string; email: string; role: string };
}

/** Управление расписаниями автономных задач агентов (CRON-43.1/43.2). */
@Controller('workspaces/:workspaceId/schedules')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('user', 'admin', 'owner')
export class SchedulesController {
  constructor(private readonly jobs: ScheduledJobsService) {}

  @Get()
  list(
    @Req() request: AuthenticatedRequest,
    @Param('workspaceId') workspaceId: string,
  ): Promise<ScheduledJobView[]> {
    return this.jobs.list(this.userId(request), workspaceId);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @Req() request: AuthenticatedRequest,
    @Param('workspaceId') workspaceId: string,
    @Body() body: unknown,
  ): Promise<ScheduledJobView> {
    return this.jobs.create(this.userId(request), workspaceId, body);
  }

  @Patch(':jobId')
  update(
    @Req() request: AuthenticatedRequest,
    @Param('workspaceId') workspaceId: string,
    @Param('jobId') jobId: string,
    @Body() body: unknown,
  ): Promise<ScheduledJobView> {
    return this.jobs.update(this.userId(request), workspaceId, jobId, body);
  }

  @Delete(':jobId')
  remove(
    @Req() request: AuthenticatedRequest,
    @Param('workspaceId') workspaceId: string,
    @Param('jobId') jobId: string,
  ): Promise<{ id: string }> {
    return this.jobs.remove(this.userId(request), workspaceId, jobId);
  }

  @Post(':jobId/run-now')
  @HttpCode(HttpStatus.OK)
  runNow(
    @Req() request: AuthenticatedRequest,
    @Param('workspaceId') workspaceId: string,
    @Param('jobId') jobId: string,
  ): Promise<JobRunResult> {
    return this.jobs.runNow(this.userId(request), workspaceId, jobId);
  }

  private userId(request: AuthenticatedRequest): string {
    const userId = request.user?.userId;

    if (userId === undefined || userId === '') {
      throw new UnauthorizedException('Пользователь не аутентифицирован');
    }

    return userId;
  }
}
