import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { LlmModule } from '../llm/llm.module.js';
import { LlmRouterModule } from '../llm-router/llm-router.module.js';
import { MemoryModule } from '../memory/memory.module.js';
import { SecurityModule } from '../security/security.module.js';
import { SkillsModule } from '../skills/skills.module.js';
import { ChatController } from './chat.controller.js';
import { ChatGateway } from './chat.gateway.js';
import { ChatService } from './chat.service.js';

@Module({
  imports: [
    AuthModule,
    LlmModule,
    LlmRouterModule,
    SecurityModule,
    BillingModule,
    SkillsModule,
    MemoryModule,
  ],
  controllers: [ChatController],
  providers: [ChatGateway, ChatService],
  exports: [ChatService],
})
export class ChatModule {}
