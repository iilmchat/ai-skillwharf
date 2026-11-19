import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { WorkspaceContextGuard } from './workspace-context.guard.js';
import { WorkspacesController } from './workspaces.controller.js';
import { WorkspacesService } from './workspaces.service.js';

/** Мульти-тенантные воркспейсы и матрица прав (Sprint 31). */
@Module({
  imports: [AuthModule],
  controllers: [WorkspacesController],
  providers: [WorkspacesService, WorkspaceContextGuard],
  exports: [WorkspacesService, WorkspaceContextGuard],
})
export class WorkspacesModule {}
