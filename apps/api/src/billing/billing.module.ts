import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { BILLING_PROVIDER } from './billing.constants.js';
import { BillingController } from './billing.controller.js';
import { BillingService } from './billing.service.js';
import { FreemiumResetService } from './freemium-reset.service.js';
import { MockYooKassaProvider } from './providers/mock-yookassa.provider.js';
import { YooKassaProvider } from './providers/yookassa.provider.js';

@Module({
  imports: [AuthModule],
  controllers: [BillingController],
  providers: [
    BillingService,
    // Месячный сброс Freemium-лимитов: таймер внутри процесса, unref-нутый.
    FreemiumResetService,
    MockYooKassaProvider,
    YooKassaProvider,
    // Если заданы ключи ЮKassa, BAL работает с реальным провайдером,
    // иначе остаётся mock для локальной разработки и тестов.
    {
      provide: BILLING_PROVIDER,
      inject: [YooKassaProvider, MockYooKassaProvider],
      useFactory: (yooKassa: YooKassaProvider, mock: MockYooKassaProvider) =>
        yooKassa.isConfigured() ? yooKassa : mock,
    },
  ],
  exports: [
    BillingService,
    MockYooKassaProvider,
    YooKassaProvider,
    BILLING_PROVIDER,
  ],
})
export class BillingModule {}
