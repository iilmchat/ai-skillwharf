import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { createFakeCheckpointPrisma } from '../../../test/checkpointer/fake-checkpoint-store.js';
import { PendingApprovalService } from './pending-approval.service.js';
import { ChatPersistenceModule, GRAPH_CHECKPOINTER } from './persistence.module.js';
import { PrismaCheckpointSaver } from './prisma-checkpoint.saver.js';

describe('ChatPersistenceModule', () => {
  it('провайдит checkpointer по токену GRAPH_CHECKPOINTER и PendingApprovalService', async () => {
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

    await moduleRef.close();
  });
});
