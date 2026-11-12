import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { LlmRouterController } from './llm-router.controller.js';
import { LlmRouterService } from './llm-router.service.js';

@Module({
  imports: [AuthModule, AuditModule],
  controllers: [LlmRouterController],
  providers: [LlmRouterService],
  exports: [LlmRouterService],
})
export class LlmRouterModule {}
