import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  PrismaHealthIndicator,
} from '@nestjs/terminus';
import { PrismaService } from '../prisma/prisma.service.js';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaIndicator: PrismaHealthIndicator,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @HealthCheck()
  async check(): Promise<{ status: 'ok'; database: true }> {
    // Terminus вернёт 503 и JSON с деталями, если проверка БД провалится.
    await this.health.check([
      () => this.prismaIndicator.pingCheck('database', this.prisma),
    ]);

    return { status: 'ok', database: true };
  }
}
