import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CustomAgentRolesController } from './custom-agents.controller.js';
import { CustomAgentRolesService } from './custom-agents.service.js';
import { WorkspaceContextGuard } from './workspace-context.guard.js';
import { WorkspacesController } from './workspaces.controller.js';
import { WorkspacesService } from './workspaces.service.js';

/** Мульти-тенантные воркспейсы и матрица прав (Sprint 31, 35). */
@Module({
  imports: [AuthModule],
  controllers: [WorkspacesController, CustomAgentRolesController],
  providers: [
    WorkspacesService,
    WorkspaceContextGuard,
    CustomAgentRolesService,
  ],
  exports: [
    WorkspacesService,
    WorkspaceContextGuard,
    CustomAgentRolesService,
  ],
})
export class WorkspacesModule {}
