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
import { TelegramBotService } from './telegram/telegram-bot.service.js';
import { TelegramLinkService } from './telegram/telegram-link.service.js';

interface AuthenticatedRequest extends Request {
  user?: { userId: string; email: string; role: string };
}

const telegramConnectSchema = z
  .object({ botToken: z.string().min(1).max(256) })
  .strict();

/** Состояние интеграции для UI (контракт `GET /integrations`). */
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
}

/**
 * Раздел «Интеграции»: сводный статус Telegram/Google и управление ботом.
 *
 * Контракт совпадает с `apps/web/src/lib/integrations.ts`:
 * `GET /integrations`, `POST/DELETE /integrations/telegram`.
 */
@Controller('integrations')
export class IntegrationsController {
  private readonly logger = new Logger(IntegrationsController.name);

  constructor(
    private readonly telegramBots: TelegramBotService,
    private readonly telegramLinks: TelegramLinkService,
    private readonly google: GoogleOAuthService,
  ) {}

  /** Сводное состояние обоих провайдеров. */
  @Get()
  @UseGuards(JwtAuthGuard)
  async status(@Req() request: AuthenticatedRequest): Promise<IntegrationsState> {
    const userId = requireUserId(request);
    const [telegram, google] = await Promise.all([
      this.telegramBots.describe(userId),
      this.google.status(userId),
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
}

function requireUserId(request: AuthenticatedRequest): string {
  const userId = request.user?.userId;

  if (!userId) {
    throw new UnauthorizedException('Пользователь не аутентифицирован');
  }

  return userId;
}
