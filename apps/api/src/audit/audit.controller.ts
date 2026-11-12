import { Controller, Get, UseGuards } from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../auth/guards/roles.guard.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { AuditService, type AuditLogView } from './audit.service.js';

@Controller('admin')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  @Get('audit')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'owner')
  list(): Promise<AuditLogView[]> {
    return this.auditService.getLogs();
  }
}
