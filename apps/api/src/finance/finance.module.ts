import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { FinanceController } from './finance.controller.js';
import { FinanceService } from './finance.service.js';

/**
 * Финансовый дашборд: чтение результатов инструментов агента.
 *
 * `FinanceSnapshotStore` живёт в `AgentModule` (туда пишут инструменты) и
 * экспортируется оттуда, поэтому цикла модулей нет.
 */
@Module({
  imports: [AuthModule, AgentModule],
  controllers: [FinanceController],
  providers: [FinanceService],
})
export class FinanceModule {}
