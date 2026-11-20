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
import { TelegramChannelWebhookService } from './telegram-channel-webhook.service.js';

/** Публичный приёмник обновлений Telegram (OMNI-39.2/HITL-39.3). */
@Controller()
export class TelegramChannelWebhookController {
  constructor(private readonly webhook: TelegramChannelWebhookService) {}

  @Post('webhooks/telegram/:channelId')
  @HttpCode(HttpStatus.OK)
  receive(
    @Param('channelId') channelId: string,
    @Req() request: Request,
    @Body() body: unknown,
  ): Promise<{ ok: true }> {
    return this.webhook.handle(
      channelId,
      request.header('x-telegram-bot-api-secret-token'),
      body,
    );
  }
}
