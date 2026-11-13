import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { MetricsService } from './metrics.service.js';

/**
 * `/metrics` для Prometheus. Контроллер исключён из глобального префикса
 * `api/v1` в `main.ts`, поэтому скрейпится по короткому пути.
 */
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  async getMetrics(
    @Res({ passthrough: true }) response: Response,
  ): Promise<string> {
    const { contentType, body } = await this.metrics.render();

    response.setHeader('Content-Type', contentType);
    response.setHeader('Cache-Control', 'no-store');

    return body;
  }
}
