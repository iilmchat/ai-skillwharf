import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ChatModule } from '../chat/chat.module.js';
import { WorkspacesModule } from '../workspaces/workspaces.module.js';
import { TriggersController } from './triggers.controller.js';
import { TriggersService } from './triggers.service.js';

/** Event-Driven агенты: входящие webhook-триггеры (Sprint 32). */
@Module({
  imports: [AuthModule, ChatModule, WorkspacesModule],
  controllers: [TriggersController],
  providers: [TriggersService],
  exports: [TriggersService],
})
export class TriggersModule {}
