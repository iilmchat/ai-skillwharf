import { Module } from '@nestjs/common';
import { GoogleApiService } from './google/google-api.service.js';
import { GoogleOAuthService } from './google/google-oauth.service.js';
import { TokenCipherService } from './google/token-cipher.service.js';
import { ProviderKeysService } from './keys/provider-keys.service.js';
import { TelegramBotService } from './telegram/telegram-bot.service.js';
import { TelegramService } from './telegram/telegram.service.js';

/**
 * Внешние провайдеры (Telegram Bot API, Google Workspace, Ozon/WB/Midjourney).
 *
 * Модуль не зависит от ChatModule: его импортирует AgentModule (инструменты)
 * и IntegrationsModule (контроллеры/webhook), поэтому цикла нет.
 */
@Module({
  providers: [
    TokenCipherService,
    TelegramService,
    TelegramBotService,
    GoogleOAuthService,
    GoogleApiService,
    ProviderKeysService,
  ],
  exports: [
    TokenCipherService,
    TelegramService,
    TelegramBotService,
    GoogleOAuthService,
    GoogleApiService,
    ProviderKeysService,
  ],
})
export class ProvidersModule {}
