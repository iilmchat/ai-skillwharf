import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { CorpWebhookService } from './corp-webhook.service.js';

/** Публичный приёмник событий корпоративных мессенджеров (OMNI-40.1). */
@Controller()
export class CorpWebhookController {
  constructor(private readonly webhook: CorpWebhookService) {}

  @Post('webhooks/corporate/:channelId')
  @HttpCode(HttpStatus.OK)
  receive(
    @Param('channelId') channelId: string,
    @Req() request: Request,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    const secret =
      typeof request.header('x-webhook-secret') === 'string'
        ? request.header('x-webhook-secret')
        : request.header('x-signature');
    const headers: Record<string, string> = {};

    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value === 'string') {
        headers[name] = value;
      } else if (Array.isArray(value) && value.length > 0) {
        headers[name] = value[0]!;
      }
    }

    return this.webhook.handle(channelId, secret, headers, body);
  }
}
