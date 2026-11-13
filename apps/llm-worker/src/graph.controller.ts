import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Logger,
  Post,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  resumeGraphRequestSchema,
  runGraphRequestSchema,
  type GraphEvent,
} from './contracts.js';
import { AgentRunnerService } from './agent/runner.service.js';

/** Общий внутренний токен API ↔ worker. Пустой — только для локальной разработки. */
function assertInternalToken(token: string | undefined): void {
  const expected = process.env.INTERNAL_API_TOKEN?.trim() ?? '';

  if (expected === '') {
    return;
  }

  if (token !== expected) {
    throw new UnauthorizedException('Invalid internal token');
  }
}

function writeEvent(response: Response, event: GraphEvent): void {
  response.write(`${JSON.stringify(event)}\n`);
}

@Controller('v1/graphs')
export class GraphsController {
  private readonly logger = new Logger(GraphsController.name);

  constructor(private readonly runner: AgentRunnerService) {}

  @Post('run')
  @HttpCode(200)
  async run(
    @Body() body: unknown,
    @Headers('x-internal-token') token: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    assertInternalToken(token);

    const parsed = runGraphRequestSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException(parsed.error.message);
    }

    await this.stream(response, this.runner.run(parsed.data));
  }

  @Post('resume')
  @HttpCode(200)
  async resume(
    @Body() body: unknown,
    @Headers('x-internal-token') token: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    assertInternalToken(token);

    const parsed = resumeGraphRequestSchema.safeParse(body);

    if (!parsed.success) {
      throw new BadRequestException(parsed.error.message);
    }

    await this.stream(response, this.runner.resume(parsed.data));
  }

  private async stream(
    response: Response,
    events: AsyncIterable<GraphEvent>,
  ): Promise<void> {
    response.setHeader('content-type', 'application/x-ndjson; charset=utf-8');
    response.setHeader('cache-control', 'no-cache');
    response.flushHeaders();

    try {
      for await (const event of events) {
        writeEvent(response, event);
      }
    } catch (error) {
      this.logger.error(
        `Graph stream failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      writeEvent(response, {
        type: 'error',
        statusCode: 500,
        message: 'Graph stream failed',
      });
    } finally {
      response.end();
    }
  }
}

@Controller('v1/health')
export class WorkerHealthController {
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  ready(): { status: 'ok'; internalApi: boolean } {
    return {
      status: 'ok',
      internalApi:
        (process.env.INTERNAL_API_URL?.trim() ?? '') !== '',
    };
  }
}
