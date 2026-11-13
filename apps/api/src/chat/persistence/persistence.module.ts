import { Module } from '@nestjs/common';
import { PendingApprovalService } from './pending-approval.service.js';
import { PrismaCheckpointSaver } from './prisma-checkpoint.saver.js';

/**
 * Токен DI для checkpointer'а. ChatService принимает его как
 * `BaseCheckpointSaver`, поэтому конкретная реализация (PostgreSQL, in-memory
 * в тестах) подменяется без правок бизнес-логики.
 */
export const GRAPH_CHECKPOINTER = Symbol('GRAPH_CHECKPOINTER');

/**
 * Persistence чата: checkpointer LangGraph и ожидающие одобрения действия.
 * PrismaModule глобальный (см. app.module.ts), поэтому импортировать его не
 * нужно.
 */
@Module({
  providers: [
    PendingApprovalService,
    { provide: GRAPH_CHECKPOINTER, useClass: PrismaCheckpointSaver },
  ],
  exports: [PendingApprovalService, GRAPH_CHECKPOINTER],
})
export class ChatPersistenceModule {}
