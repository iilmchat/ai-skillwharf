import { Module } from '@nestjs/common';
import { SandboxModule } from '../sandbox/sandbox.module.js';
import { LlmService } from './llm.service.js';

@Module({
  imports: [SandboxModule],
  providers: [LlmService],
  exports: [LlmService],
})
export class LlmModule {}
