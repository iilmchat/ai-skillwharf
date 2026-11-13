import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { createFakeCheckpointPrisma } from '../../../test/checkpointer/fake-checkpoint-store.js';
import { CheckpointRetentionService } from './checkpoint-retention.service.js';
import { ExpiredApprovalsService } from './expired-approvals.service.js';
import { PendingApprovalService } from './pending-approval.service.js';
import {
  ChatPersistenceModule,
  GRAPH_CHECKPOINTER,
} from './persistence.module.js';
import { PrismaCheckpointSaver } from './prisma-checkpoint.saver.js';

describe('ChatPersistenceModule', () => {
  // BillingModule (импортируется ради BillingService) тянет AuthModule,
  // а JwtStrategy требует секрет уже на этапе создания DI-контейнера.
  let originalJwtSecret: string | undefined;

  beforeAll(() => {
    originalJwtSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'test-secret';
  });

  afterAll(() => {
    if (originalJwtSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = originalJwtSecret;
    }
  });

  it('провайдит checkpointer, PendingApprovalService и фоновые jobs', async () => {
    const store = createFakeCheckpointPrisma();
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, ChatPersistenceModule],
    })
      .overrideProvider(PrismaService)
      .useValue(store.prisma)
      .compile();

    const saver = moduleRef.get<PrismaCheckpointSaver>(GRAPH_CHECKPOINTER);
    expect(saver).toBeInstanceOf(PrismaCheckpointSaver);

    const pendingApprovals =
      moduleRef.get<PendingApprovalService>(PendingApprovalService);
    expect(pendingApprovals).toBeInstanceOf(PendingApprovalService);

    expect(moduleRef.get(ExpiredApprovalsService)).toBeInstanceOf(
      ExpiredApprovalsService,
    );
    expect(moduleRef.get(CheckpointRetentionService)).toBeInstanceOf(
      CheckpointRetentionService,
    );

    await moduleRef.close();
  });
});
