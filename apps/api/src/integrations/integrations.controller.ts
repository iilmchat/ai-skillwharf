import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
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
@ApiTags('Integrations')
@ApiBearerAuth()
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
  @ApiOperation({ summary: 'Состояние всех интеграций пользователя' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Статусы Telegram, Google, Ozon, WB и Midjourney.',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'JWT отсутствует или недействителен.',
  })
  async status(
    @Req() request: AuthenticatedRequest,
  ): Promise<IntegrationsState> {
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
  @ApiOperation({ summary: 'Подключить Telegram-бота' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Бот подключён, токен сохранён в зашифрованном виде.',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Ожидается { botToken }.',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'JWT отсутствует или недействителен.',
  })
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

    const info = await this.telegramBots.connect(userId, parsed.data.botToken);

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
  @ApiOperation({ summary: 'Отключить Telegram-бота' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Бот отключён, привязки чатов удалены.',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'JWT отсутствует или недействителен.',
  })
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
  @ApiOperation({ summary: 'Подключить ключи Ozon' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Ключи Ozon сохранены.',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Ожидается { clientId, apiKey }.',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'JWT отсутствует или недействителен.',
  })
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
  @ApiOperation({ summary: 'Отключить Ozon' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Ключи Ozon удалены.',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'JWT отсутствует или недействителен.',
  })
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
  @ApiOperation({ summary: 'Подключить токен Wildberries' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Токен Wildberries сохранён.',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Ожидается { apiToken }.',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'JWT отсутствует или недействителен.',
  })
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
  @ApiOperation({ summary: 'Отключить Wildberries' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Токен Wildberries удалён.',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'JWT отсутствует или недействителен.',
  })
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
  @ApiOperation({ summary: 'Подключить ключ Midjourney (TTAPI)' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Ключ Midjourney сохранён.',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Ожидается { apiKey }.',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'JWT отсутствует или недействителен.',
  })
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
  @ApiOperation({ summary: 'Отключить Midjourney' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Ключ Midjourney удалён.',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'JWT отсутствует или недействителен.',
  })
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
