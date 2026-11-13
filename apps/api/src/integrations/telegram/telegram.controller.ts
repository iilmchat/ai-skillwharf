import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Logger,
  Optional,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { z } from 'zod';
import { invalidRequestError } from '../../common/api-error.js';
import { JwtAuthGuard } from '../../auth/jwt-auth.guard.js';
import { Roles } from '../../auth/decorators/roles.decorator.js';
import { RolesGuard } from '../../auth/guards/roles.guard.js';
import { TelegramConfig } from './telegram.config.js';
import { TelegramLinkService } from './telegram-link.service.js';
import {
  TELEGRAM_WEBHOOK_RATE_LIMIT,
  TELEGRAM_WEBHOOK_TTL_MS,
  TelegramWebhookService,
} from './telegram-webhook.service.js';
import { TelegramService } from './telegram.service.js';

interface AuthenticatedRequest extends Request {
  user?: { userId: string; email: string; role: string };
}

const linkBodySchema = z.object({ chatId: z.string().min(1).max(128) }).strict();
const registerBodySchema = z
  .object({ publicUrl: z.url().max(2_048) })
  .strict();

/**
 * Webhook и привязка Telegram.
 *
 * `POST /integrations/telegram/webhook` — публичный маршрут для Telegram:
 * подлинность запроса подтверждает `X-Telegram-Bot-Api-Secret-Token`.
 * Публичный alias для Caddy — `POST /webhooks/telegram` (см.
 * `TelegramPublicWebhookController`). Остальные маршруты — JWT; регистрация
 * webhook — только admin.
 */
@Controller('integrations/telegram')
export class TelegramController {
  private readonly logger = new Logger(TelegramController.name);
  private readonly config: TelegramConfig;

  constructor(
    private readonly telegram: TelegramService,
    private readonly links: TelegramLinkService,
    private readonly webhooks: TelegramWebhookService,
    @Optional() config?: TelegramConfig,
  ) {
    this.config = config ?? TelegramConfig.fromEnv();
  }

  /** Приём обновлений Telegram. Всегда 200: иначе Telegram будет ретраить. */
  @Post('webhook')
  @HttpCode(200)
  @Throttle({
    default: { limit: TELEGRAM_WEBHOOK_RATE_LIMIT, ttl: TELEGRAM_WEBHOOK_TTL_MS },
  })
  async webhook(
    @Headers('x-telegram-bot-api-secret-token') secret: string | undefined,
    @Body() body: unknown,
  ): Promise<{ ok: boolean }> {
    return this.webhooks.handle(secret, body);
  }

  /** Привязка чата к текущему пользователю. */
  @Post('link')
  @UseGuards(JwtAuthGuard)
  @HttpCode(200)
  async link(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<{
    chatId: string;
    conversationId: string;
    createdAt: string;
  }> {
    const userId = requireUserId(request);
    const parsed = linkBodySchema.safeParse(body);

    if (!parsed.success) {
      throw invalidRequestError('Ожидается { chatId }');
    }

    const link = await this.links.link(userId, parsed.data.chatId);

    return {
      chatId: link.chatId,
      conversationId: link.conversationId,
      createdAt: link.createdAt.toISOString(),
    };
  }

  /** Список привязанных чатов пользователя. */
  @Get('link')
  @UseGuards(JwtAuthGuard)
  async listLinks(@Req() request: AuthenticatedRequest): Promise<{
    items: Array<{ chatId: string; conversationId: string; createdAt: string }>;
  }> {
    const userId = requireUserId(request);
    const rows = await this.links.listForUser(userId);

    return {
      items: rows.map((row) => ({
        chatId: row.chatId,
        conversationId: row.conversationId,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  /** Удаление привязки чата. */
  @Delete('link/:chatId')
  @UseGuards(JwtAuthGuard)
  async unlink(
    @Req() request: AuthenticatedRequest,
    @Param('chatId') chatId: string,
  ): Promise<{ removed: boolean }> {
    const userId = requireUserId(request);

    return { removed: await this.links.unlink(userId, chatId) };
  }

  /** Регистрация webhook в Telegram (admin, при деплое). */
  @Post('webhook/register')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'owner')
  @HttpCode(200)
  async registerWebhook(
    @Body() body: unknown,
  ): Promise<{ registered: boolean }> {
    const parsed = registerBodySchema.safeParse(body);

    if (!parsed.success) {
      throw invalidRequestError('Ожидается { publicUrl }');
    }

    await this.telegram.setWebhook(
      parsed.data.publicUrl,
      this.config.webhookSecret ?? undefined,
    );

    this.logger.log('Telegram: webhook зарегистрирован');

    return { registered: true };
  }

  /** Состояние интеграции (без секретов). */
  @Get('status')
  @UseGuards(JwtAuthGuard)
  async status(): Promise<{
    configured: boolean;
    webhookSecretConfigured: boolean;
  }> {
    return {
      configured: this.telegram.isConfigured(),
      webhookSecretConfigured: this.config.webhookSecret !== null,
    };
  }
}

/**
 * Публичный alias `/api/v1/webhooks/telegram`.
 *
 * Caddy проксирует его напрямую в API; отдельный контроллер нужен, чтобы
 * публичный контракт не зависел от внутренней структуры integrations.
 */
@Controller('webhooks')
export class TelegramPublicWebhookController {
  constructor(private readonly webhooks: TelegramWebhookService) {}

  @Post('telegram')
  @HttpCode(200)
  @Throttle({
    default: { limit: TELEGRAM_WEBHOOK_RATE_LIMIT, ttl: TELEGRAM_WEBHOOK_TTL_MS },
  })
  async telegram(
    @Headers('x-telegram-bot-api-secret-token') secret: string | undefined,
    @Body() body: unknown,
  ): Promise<{ ok: boolean }> {
    return this.webhooks.handle(secret, body);
  }
}

function requireUserId(request: AuthenticatedRequest): string {
  const userId = request.user?.userId;

  if (!userId) {
    throw new UnauthorizedException('Пользователь не аутентифицирован');
  }

  return userId;
}

export { safeEqual, errorText } from './telegram-webhook.service.js';
