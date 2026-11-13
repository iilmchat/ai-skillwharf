import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Logger,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { invalidRequestError } from '../common/api-error.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { GoogleOAuthService } from './google/google-oauth.service.js';
import {
  KEY_PROVIDERS,
  midjourneyKeysSchema,
  ozonKeysSchema,
  wildberriesKeysSchema,
  type KeyProvider,
} from './keys/provider-keys.schemas.js';
import {
  ProviderKeysService,
  type MidjourneyIntegrationState,
  type OzonIntegrationState,
  type WildberriesIntegrationState,
} from './keys/provider-keys.service.js';
import { TelegramBotService } from './telegram/telegram-bot.service.js';
import { TelegramLinkService } from './telegram/telegram-link.service.js';

interface AuthenticatedRequest extends Request {
  user?: { userId: string; email: string; role: string };
}

const telegramConnectSchema = z
  .object({ botToken: z.string().min(1).max(256) })
  .strict();

/**
 * Состояние интеграции для UI (контракт `GET /integrations`).
 *
 * Поля `ozon`/`wildberries`/`midjourney` совпадают с
 * `apps/web/src/lib/integrations.ts`; лишнее поле `source` показывает,
 * работают ли ключи пользователя или системные (env).
 */
export interface IntegrationsState {
  readonly telegram: {
    status: 'active' | 'disconnected' | 'error';
    botName?: string;
    botUsername?: string;
    error?: string;
  };
  readonly google: {
    status: 'active' | 'disconnected' | 'error';
    email?: string;
    error?: string;
  };
  readonly ozon: OzonIntegrationState;
  readonly wildberries: WildberriesIntegrationState;
  readonly midjourney: MidjourneyIntegrationState;
}

/**
 * Раздел «Интеграции»: сводный статус провайдеров и управление ими.
 *
 * Контракт совпадает с `apps/web/src/lib/integrations.ts`:
 * `GET /integrations`, `POST/DELETE /integrations/{telegram|ozon|wildberries|midjourney}`.
 */
@Controller('integrations')
export class IntegrationsController {
  private readonly logger = new Logger(IntegrationsController.name);

  constructor(
    private readonly telegramBots: TelegramBotService,
    private readonly telegramLinks: TelegramLinkService,
    private readonly google: GoogleOAuthService,
    private readonly providerKeys: ProviderKeysService,
  ) {}

  /** Сводное состояние всех провайдеров. */
  @Get()
  @UseGuards(JwtAuthGuard)
  async status(@Req() request: AuthenticatedRequest): Promise<IntegrationsState> {
    const userId = requireUserId(request);
    const [telegram, google, providers] = await Promise.all([
      this.telegramBots.describe(userId),
      this.google.status(userId),
      this.providerKeys.describe(userId),
    ]);

    return {
      telegram: {
        status: telegram.status,
        ...(telegram.botName === undefined
          ? {}
          : { botName: telegram.botName }),
        ...(telegram.botUsername === undefined
          ? {}
          : { botUsername: telegram.botUsername }),
        ...(telegram.error === undefined ? {} : { error: telegram.error }),
      },
      google: {
        status: google.connected ? 'active' : 'disconnected',
        ...(google.email === undefined ? {} : { email: google.email }),
      },
      ozon: providers.ozon,
      wildberries: providers.wildberries,
      midjourney: providers.midjourney,
    };
  }

  /**
   * Подключает Telegram-бота пользователя: токен проверяется через `getMe`
   * и сохраняется зашифрованным.
   */
  @Post('telegram')
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  async connectTelegram(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<{
    status: 'active';
    botName: string;
    botUsername?: string;
  }> {
    const userId = requireUserId(request);
    const parsed = telegramConnectSchema.safeParse(body);

    if (!parsed.success) {
      throw invalidRequestError('Ожидается { botToken }');
    }

    const info = await this.telegramBots.connect(
      userId,
      parsed.data.botToken,
    );

    this.logger.log(
      JSON.stringify({
        event: 'telegram.integration_connected',
        userId,
        botId: info.id,
      }),
    );

    return {
      status: 'active',
      botName: info.name,
      ...(info.username === undefined ? {} : { botUsername: info.username }),
    };
  }

  /** Отключает бота пользователя и удаляет привязки его чатов. */
  @Delete('telegram')
  @UseGuards(JwtAuthGuard)
  async disconnectTelegram(
    @Req() request: AuthenticatedRequest,
  ): Promise<{ disconnected: boolean }> {
    const userId = requireUserId(request);
    const links = await this.telegramLinks.listForUser(userId);

    await Promise.all(
      links.map((link) => this.telegramLinks.unlink(userId, link.chatId)),
    );

    return { disconnected: await this.telegramBots.disconnect(userId) };
  }

  /** Подключает ключи Ozon: `{ clientId, apiKey }` (секреты шифруются). */
  @Post('ozon')
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  async connectOzon(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<OzonIntegrationState> {
    const userId = requireUserId(request);
    const parsed = ozonKeysSchema.safeParse(body);

    if (!parsed.success) {
      throw invalidRequestError('Ожидается { clientId, apiKey }');
    }

    return this.providerKeys.connectOzon(userId, parsed.data);
  }

  /** Удаляет ключи Ozon пользователя. */
  @Delete('ozon')
  @UseGuards(JwtAuthGuard)
  async disconnectOzon(
    @Req() request: AuthenticatedRequest,
  ): Promise<{ disconnected: boolean }> {
    return {
      disconnected: await this.providerKeys.disconnect(
        requireUserId(request),
        'ozon',
      ),
    };
  }

  /** Подключает токен Wildberries: `{ apiToken }`. */
  @Post('wildberries')
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  async connectWildberries(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<WildberriesIntegrationState> {
    const userId = requireUserId(request);
    const parsed = wildberriesKeysSchema.safeParse(body);

    if (!parsed.success) {
      throw invalidRequestError('Ожидается { apiToken }');
    }

    return this.providerKeys.connectWildberries(userId, parsed.data);
  }

  /** Удаляет токен Wildberries пользователя. */
  @Delete('wildberries')
  @UseGuards(JwtAuthGuard)
  async disconnectWildberries(
    @Req() request: AuthenticatedRequest,
  ): Promise<{ disconnected: boolean }> {
    return {
      disconnected: await this.providerKeys.disconnect(
        requireUserId(request),
        'wildberries',
      ),
    };
  }

  /** Подключает ключ TTAPI для Midjourney: `{ apiKey }`. */
  @Post('midjourney')
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  async connectMidjourney(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<MidjourneyIntegrationState> {
    const userId = requireUserId(request);
    const parsed = midjourneyKeysSchema.safeParse(body);

    if (!parsed.success) {
      throw invalidRequestError('Ожидается { apiKey }');
    }

    return this.providerKeys.connectMidjourney(userId, parsed.data);
  }

  /** Удаляет ключ Midjourney пользователя. */
  @Delete('midjourney')
  @UseGuards(JwtAuthGuard)
  async disconnectMidjourney(
    @Req() request: AuthenticatedRequest,
  ): Promise<{ disconnected: boolean }> {
    return {
      disconnected: await this.providerKeys.disconnect(
        requireUserId(request),
        'midjourney',
      ),
    };
  }
}

/** Провайдеры с ключами: используются для типизации и проверок. */
export const KEY_INTEGRATION_PROVIDERS: readonly KeyProvider[] = KEY_PROVIDERS;

function requireUserId(request: AuthenticatedRequest): string {
  const userId = request.user?.userId;

  if (!userId) {
    throw new UnauthorizedException('Пользователь не аутентифицирован');
  }

  return userId;
}
