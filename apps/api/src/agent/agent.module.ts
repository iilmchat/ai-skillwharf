import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module.js';
import { ChatPersistenceModule } from '../chat/persistence/persistence.module.js';
import { ProvidersModule } from '../integrations/providers.module.js';
import { SandboxModule } from '../sandbox/sandbox.module.js';
import { SecurityModule } from '../security/security.module.js';
import { AgentInternalController } from './agent-internal.controller.js';
import { AgentRuntimeService } from './agent-runtime.service.js';
import { AgentToolsService } from './agent-tools.service.js';
import { LlmBudgetService } from './llm-budget.service.js';
import { LlmWorkerClient } from './llm-worker.client.js';

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
  ],
  exports: [
    AgentToolsService,
    AgentRuntimeService,
    LlmBudgetService,
    LlmWorkerClient,
  ],
})
export class AgentModule {}
