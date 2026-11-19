import { Global, Module } from '@nestjs/common';
import { MetricsController } from './metrics.controller.js';
import { METRICS_ENV, MetricsService } from './metrics.service.js';

/**
 * Метрики нужны и LLM-сервису, и HTTP-слою, поэтому модуль глобальный.
 */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [
    MetricsService,
    // Явный провайдер для примитива env (KI-088); @Optional() в конструкторе
    // оставляет возможность создавать сервис напрямую в unit-тестах.
    { provide: METRICS_ENV, useValue: process.env },
  ],
  exports: [MetricsService],
})
export class MetricsModule {}
