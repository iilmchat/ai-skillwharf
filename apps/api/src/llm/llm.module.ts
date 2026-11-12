import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module.js';
import { PromptsModule } from '../prompts/prompts.module.js';
import { SandboxModule } from '../sandbox/sandbox.module.js';
import { LlmService } from './llm.service.js';

@Module({
  // BillingModule нужен, чтобы списывать стоимость токенов LLM.
  imports: [SandboxModule, PromptsModule, BillingModule],
  providers: [LlmService],
  exports: [LlmService],
})
export class LlmModule {}
