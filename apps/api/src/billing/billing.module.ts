import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { BILLING_PROVIDER } from './billing.constants.js';
import { BillingController } from './billing.controller.js';
import { BillingService } from './billing.service.js';
import { MockYooKassaProvider } from './providers/mock-yookassa.provider.js';

@Module({
  imports: [AuthModule],
  controllers: [BillingController],
  providers: [
    BillingService,
    MockYooKassaProvider,
    // По умолчанию BAL использует mock-провайдер; реальный адаптер ЮKassa
    // подключается заменой этого провайдера.
    { provide: BILLING_PROVIDER, useExisting: MockYooKassaProvider },
  ],
  exports: [BillingService, MockYooKassaProvider, BILLING_PROVIDER],
})
export class BillingModule {}
