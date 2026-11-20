import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ChatModule } from '../chat/chat.module.js';
import { ProvidersModule } from '../integrations/providers.module.js';
import { WorkspacesModule } from '../workspaces/workspaces.module.js';
import { CorpMessengerAdapterRegistry } from './adapters/corp-messenger.registry.js';
import { CorpChannelsController } from './corp-channels.controller.js';
import { CorpChannelsService } from './corp-channels.service.js';
import { CorpWebhookController } from './corp-webhook.controller.js';
import { CorpWebhookService } from './corp-webhook.service.js';
import { TelegramChannelWebhookController } from './telegram-webhook.controller.js';
import { TelegramChannelWebhookService } from './telegram-channel-webhook.service.js';
import { TelegramChannelsController } from './telegram-channels.controller.js';
import { TelegramChannelsService } from './telegram-channels.service.js';

/** Омниканальность: Telegram и корпоративные мессенджеры (Спринты 39–40). */
@Module({
  imports: [AuthModule, ChatModule, WorkspacesModule, ProvidersModule],
  controllers: [
    TelegramChannelsController,
    TelegramChannelWebhookController,
    CorpChannelsController,
    CorpWebhookController,
  ],
  providers: [
    TelegramChannelsService,
    TelegramChannelWebhookService,
    CorpChannelsService,
    CorpWebhookService,
    CorpMessengerAdapterRegistry,
  ],
  exports: [TelegramChannelsService, CorpChannelsService],
})
export class ChannelsModule {}
