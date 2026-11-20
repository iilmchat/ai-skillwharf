import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ChatModule } from '../chat/chat.module.js';
import { ProvidersModule } from '../integrations/providers.module.js';
import { WorkspacesModule } from '../workspaces/workspaces.module.js';
import { TelegramChannelWebhookController } from './telegram-webhook.controller.js';
import { TelegramChannelWebhookService } from './telegram-channel-webhook.service.js';
import { TelegramChannelsController } from './telegram-channels.controller.js';
import { TelegramChannelsService } from './telegram-channels.service.js';

/** Омниканальность: Telegram-боты воркспейсов и HITL в мессенджере (Sprint 39). */
@Module({
  imports: [AuthModule, ChatModule, WorkspacesModule, ProvidersModule],
  controllers: [TelegramChannelsController, TelegramChannelWebhookController],
  providers: [TelegramChannelsService, TelegramChannelWebhookService],
  exports: [TelegramChannelsService],
})
export class ChannelsModule {}
