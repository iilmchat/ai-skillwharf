import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  PrismaHealthIndicator,
} from '@nestjs/terminus';
import { PrismaService } from '../prisma/prisma.service.js';

interface HealthResponse {
  status: 'ok';
  database: true;
}

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaIndicator: PrismaHealthIndicator,
    private readonly prisma: PrismaService,
  ) {}

  /** Liveness: процесс жив, зависимости не проверяются. */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: проверяет доступность БД через Terminus/ping. */
  @Get('ready')
  @HealthCheck()
  async ready(): Promise<HealthResponse> {
    return this.checkDatabase();
  }

  /** Обратная совместимость: раньше readiness был на /health. */
  @Get()
  @HealthCheck()
  async check(): Promise<HealthResponse> {
    return this.checkDatabase();
  }

  private async checkDatabase(): Promise<HealthResponse> {
    // Terminus вернёт 503 и JSON с деталями, если проверка БД провалится.
    await this.health.check([
      () => this.prismaIndicator.pingCheck('database', this.prisma),
    ]);

    return { status: 'ok', database: true };
  }
}
