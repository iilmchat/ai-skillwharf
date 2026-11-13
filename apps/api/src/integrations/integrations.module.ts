import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ChatModule } from '../chat/chat.module.js';
import { GoogleController } from './google/google.controller.js';
import { IntegrationsController } from './integrations.controller.js';
import { ProvidersModule } from './providers.module.js';
import {
  TelegramController,
  TelegramPublicWebhookController,
} from './telegram/telegram.controller.js';
import { TelegramLinkService } from './telegram/telegram-link.service.js';
import { TelegramWebhookService } from './telegram/telegram-webhook.service.js';

/**
 * Контроллеры интеграций: Telegram webhook/привязка чатов и Google OAuth.
 *
 * Зависит от ChatModule, потому что входящее сообщение маршрутизируется в
 * ChatService; сами клиенты провайдеров живут в ProvidersModule.
 */
@Module({
  imports: [AuthModule, ChatModule, ProvidersModule],
  controllers: [
    IntegrationsController,
    TelegramController,
    TelegramPublicWebhookController,
    GoogleController,
  ],
  providers: [TelegramLinkService, TelegramWebhookService],
  exports: [ProvidersModule, TelegramLinkService],
})
export class IntegrationsModule {}
