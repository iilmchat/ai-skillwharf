import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { AgentModule } from '../agent/agent.module.js';
import { LlmRouterModule } from '../llm-router/llm-router.module.js';
import { MemoryModule } from '../memory/memory.module.js';
import { PromptsModule } from '../prompts/prompts.module.js';
import { SecurityModule } from '../security/security.module.js';
import { SkillsModule } from '../skills/skills.module.js';
import { ChatController } from './chat.controller.js';
import { ChatGateway } from './chat.gateway.js';
import { ChatService } from './chat.service.js';
import { ChatPersistenceModule } from './persistence/persistence.module.js';

@Module({
  imports: [
    AuthModule,
    AgentModule,
    LlmRouterModule,
    SecurityModule,
    BillingModule,
    SkillsModule,
    MemoryModule,
    PromptsModule,
    // HITL-ожидания и checkpoint-хранилище (PostgreSQL).
    ChatPersistenceModule,
  ],
  controllers: [ChatController],
  providers: [ChatGateway, ChatService],
  exports: [ChatService],
})
export class ChatModule {}
