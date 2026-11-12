import { Module } from '@nestjs/common';
import { PromptsModule } from '../prompts/prompts.module.js';
import { SandboxModule } from '../sandbox/sandbox.module.js';
import { LlmService } from './llm.service.js';

@Module({
  imports: [SandboxModule, PromptsModule],
  providers: [LlmService],
  exports: [LlmService],
})
export class LlmModule {}
