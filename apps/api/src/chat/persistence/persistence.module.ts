import { Module } from '@nestjs/common';
import { BillingModule } from '../../billing/billing.module.js';
import { CheckpointStoreService } from '../../agent/checkpoint-store.service.js';
import { CheckpointRetentionService } from './checkpoint-retention.service.js';
import { ExpiredApprovalsService } from './expired-approvals.service.js';
import { PendingApprovalService } from './pending-approval.service.js';

/**
 * Persistence чата: HITL-ожидания, checkpoint-хранилище и фоновые jobs их
 * жизненного цикла (TTL, retention).
 *
 * Сериализация checkpoint'ов живёт в llm-worker; API хранит непрозрачные
 * байты и не зависит от `@langchain/*`. PrismaModule глобальный.
 */
@Module({
  imports: [BillingModule],
  providers: [
    PendingApprovalService,
    CheckpointStoreService,
    ExpiredApprovalsService,
    CheckpointRetentionService,
  ],
  exports: [
    PendingApprovalService,
    CheckpointStoreService,
    ExpiredApprovalsService,
    CheckpointRetentionService,
  ],
})
export class ChatPersistenceModule {}
