import { Module } from '@nestjs/common';
import { BillingModule } from '../../billing/billing.module.js';
import { CheckpointRetentionService } from './checkpoint-retention.service.js';
import { ExpiredApprovalsService } from './expired-approvals.service.js';
import { GRAPH_CHECKPOINTER } from './graph-checkpointer.token.js';
import { PendingApprovalService } from './pending-approval.service.js';
import { PrismaCheckpointSaver } from './prisma-checkpoint.saver.js';

export { GRAPH_CHECKPOINTER };

/**
 * Persistence чата: checkpointer LangGraph, ожидающие одобрения действия и
 * фоновые jobs их жизненного цикла (TTL, retention).
 *
 * PrismaModule глобальный (см. app.module.ts), поэтому импортировать его не
 * нужно. BillingModule нужен для `BillingService.cancelHold` — он импортирует
 * только AuthModule, цикла с ChatModule нет.
 */
@Module({
  imports: [BillingModule],
  providers: [
    PendingApprovalService,
    { provide: GRAPH_CHECKPOINTER, useClass: PrismaCheckpointSaver },
    ExpiredApprovalsService,
    CheckpointRetentionService,
  ],
  exports: [PendingApprovalService, GRAPH_CHECKPOINTER],
})
export class ChatPersistenceModule {}
