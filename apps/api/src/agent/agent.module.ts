import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module.js';
import { ChatPersistenceModule } from '../chat/persistence/persistence.module.js';
import { ProvidersModule } from '../integrations/providers.module.js';
import { SandboxModule } from '../sandbox/sandbox.module.js';
import { SecurityModule } from '../security/security.module.js';
import { AgentInternalController } from './agent-internal.controller.js';
import { AgentRuntimeService } from './agent-runtime.service.js';
import { AgentToolsService } from './agent-tools.service.js';
import { FinanceDataService } from './finance/finance-data.service.js';
import {
  FINANCE_SNAPSHOT_REDIS_URL,
  FinanceSnapshotStore,
} from './finance/finance-snapshot.store.js';
import { FinanceToolsService } from './finance/finance-tools.service.js';
import { MidjourneyService } from './finance/midjourney.service.js';
import { LlmBudgetService } from './llm-budget.service.js';
import { LlmWorkerClient } from './llm-worker.client.js';
import { MarketplaceMcpService } from './tools/marketplace-mcp.service.js';

/**
 * Agent Gateway: инструменты, policy/billing-мост для llm-worker и
 * внутренние эндпоинты worker → API.
 */
@Module({
  imports: [
    BillingModule,
    SecurityModule,
    SandboxModule,
    ChatPersistenceModule,
    ProvidersModule,
  ],
  controllers: [AgentInternalController],
  providers: [
    AgentToolsService,
    AgentRuntimeService,
    LlmBudgetService,
    LlmWorkerClient,
    MarketplaceMcpService,
    FinanceDataService,
    FinanceToolsService,
    MidjourneyService,
    {
      // Redis общий для реплик API; без него снапшоты живут в памяти.
      provide: FINANCE_SNAPSHOT_REDIS_URL,
      useFactory: (): string => process.env.REDIS_URL ?? '',
    },
    FinanceSnapshotStore,
  ],
  exports: [
    AgentToolsService,
    AgentRuntimeService,
    LlmBudgetService,
    LlmWorkerClient,
    FinanceSnapshotStore,
  ],
})
export class AgentModule {}
