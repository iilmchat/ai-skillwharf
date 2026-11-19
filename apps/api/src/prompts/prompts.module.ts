import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { LlmRouterModule } from '../llm-router/llm-router.module.js';
import {
  EVAL_CASE_RUNNER,
  EVAL_JUDGE_CLIENT,
  PromptEvalsService,
} from './prompt-evals.service.js';
import { PromptsController } from './prompts.controller.js';
import { PromptsService } from './prompts.service.js';

@Module({
  imports: [AuthModule, AuditModule, LlmRouterModule],
  controllers: [PromptsController],
  providers: [
    PromptsService,
    PromptEvalsService,
    // Дефолтные реализации задаются в конструкторе сервиса; токены оставлены
    // как точки расширения для кастомного судьи/прогонщика в тестах и проде.
    { provide: EVAL_JUDGE_CLIENT, useValue: undefined },
    { provide: EVAL_CASE_RUNNER, useValue: undefined },
  ],
  exports: [PromptsService, PromptEvalsService],
})
export class PromptsModule {}
