import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { BillingModule } from './billing/billing.module.js';
import { ChatModule } from './chat/chat.module.js';
import { HealthModule } from './health/health.module.js';
import { IntegrationsModule } from './integrations/integrations.module.js';
import { FinanceModule } from './finance/finance.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { LlmRouterModule } from './llm-router/llm-router.module.js';
import { MetricsModule } from './metrics/metrics.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { PromptsModule } from './prompts/prompts.module.js';
import { RegistryModule } from './registry/registry.module.js';
import { SandboxModule } from './sandbox/sandbox.module.js';
import { SkillsModule } from './skills/skills.module.js';

@Module({
  imports: [
    // Базовый лимит для всех маршрутов; auth переопределяет его точечно.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 1_000 }]),
    MetricsModule,
    PrismaModule,
    JobsModule,
    HealthModule,
    AuthModule,
    ChatModule,
    SkillsModule,
    RegistryModule,
    PromptsModule,
    LlmRouterModule,
    AuditModule,
    SandboxModule,
    BillingModule,
    IntegrationsModule,
    FinanceModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
