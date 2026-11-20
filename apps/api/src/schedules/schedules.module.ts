import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ChatModule } from '../chat/chat.module.js';
import { ChannelsModule } from '../channels/channels.module.js';
import { ProvidersModule } from '../integrations/providers.module.js';
import { WorkspacesModule } from '../workspaces/workspaces.module.js';
import { SchedulesController } from './schedules.controller.js';
import { ScheduledJobsService } from './scheduled-jobs.service.js';

/** Cron-планировщик автономных задач агентов (Sprint 43). */
@Module({
  imports: [
    AuthModule,
    ChatModule,
    ChannelsModule,
    WorkspacesModule,
    ProvidersModule,
  ],
  controllers: [SchedulesController],
  providers: [ScheduledJobsService],
  exports: [ScheduledJobsService],
})
export class SchedulesModule {}
