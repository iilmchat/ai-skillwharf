import { Global, Module } from '@nestjs/common';
import { ChatPersistenceModule } from '../chat/persistence/persistence.module.js';
import { BackgroundJobsService } from './background-jobs.service.js';

/** Фоновые задачи API: BullMQ поверх Redis (если `REDIS_URL` задан). */
@Global()
@Module({
  imports: [ChatPersistenceModule],
  providers: [BackgroundJobsService],
  exports: [BackgroundJobsService],
})
export class JobsModule {}
