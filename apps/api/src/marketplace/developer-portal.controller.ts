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
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { WorkspaceContextGuard } from '../workspaces/workspace-context.guard.js';
import { DeveloperPortalService } from './developer-portal.service.js';
import type {
  DeveloperDashboard,
  DeveloperSkillItem,
} from './developer-portal.schemas.js';

interface AuthenticatedRequest extends Request {
  user?: { userId: string; email: string; role: string };
}

/** Личный кабинет автора навыков (DEVPORTAL-36.1/36.2/36.3). */
@Controller('developer/skills')
@UseGuards(JwtAuthGuard, WorkspaceContextGuard)
export class DeveloperPortalController {
  constructor(private readonly portal: DeveloperPortalService) {}

  @Get()
  dashboard(@Req() request: AuthenticatedRequest): Promise<DeveloperDashboard> {
    return this.portal.dashboard(this.userId(request));
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  publish(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<{ skill: DeveloperSkillItem }> {
    return this.portal.publish(this.userId(request), body);
  }

  @Patch(':slug/payout')
  updatePayout(
    @Req() request: AuthenticatedRequest,
    @Param('slug') slug: string,
    @Body() body: unknown,
  ): Promise<{ skill: DeveloperSkillItem }> {
    return this.portal.updatePayout(this.userId(request), slug, body);
  }

  private userId(request: AuthenticatedRequest): string {
    const userId = request.user?.userId;

    if (userId === undefined || userId === '') {
      throw new UnauthorizedException('Пользователь не аутентифицирован');
    }

    return userId;
  }
}
