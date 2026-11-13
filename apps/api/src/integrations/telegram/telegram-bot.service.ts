import { Injectable, Logger, Optional } from '@nestjs/common';
import { invalidRequestError } from '../../common/api-error.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { TokenCipherService } from '../google/token-cipher.service.js';
import { TelegramConfig } from './telegram.config.js';
import {
  TelegramService,
  type TelegramBotInfo,
} from './telegram.service.js';

/** Состояние Telegram-интеграции для UI. */
export interface TelegramIntegrationState {
  readonly status: 'active' | 'disconnected' | 'error';
  readonly botName?: string;
  readonly botUsername?: string;
  readonly error?: string;
}

/** Кэш getMe для системного бота: не дёргаем Telegram на каждый status. */
const ENV_BOT_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Подключение Telegram-бота пользователем и состояние интеграции.
 *
 * Токен проверяется через `getMe`, шифруется и хранится в `TelegramBot`.
 * Инструмент `send_message` предпочитает бота пользователя, а webhook
 * работает с системным ботом из `TELEGRAM_BOT_TOKEN` (один webhook на бота).
 */
@Injectable()
export class TelegramBotService {
  private readonly logger = new Logger(TelegramBotService.name);
  private readonly config: TelegramConfig;
  private readonly now: () => Date;
  private envBotCache: { info: TelegramBotInfo; at: number } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: TokenCipherService,
    private readonly telegram: TelegramService,
    @Optional() config?: TelegramConfig,
    @Optional() now?: () => Date,
  ) {
    this.config = config ?? TelegramConfig.fromEnv();
    this.now = now ?? (() => new Date());
  }

  /** Проверяет токен через getMe и сохраняет подключение пользователя. */
  async connect(
    userId: string,
    botToken: string,
  ): Promise<TelegramBotInfo> {
    const token = botToken.trim();

    if (token === '') {
      throw invalidRequestError('Telegram: пустой Bot Token');
    }

    const info = await this.telegram.getMe(token);
    const encrypted = this.cipher.encrypt(token);

    await this.prisma.telegramBot.upsert({
      where: { userId },
      create: {
        userId,
        token: encrypted,
        botId: String(info.id),
        botUsername: info.username ?? null,
        botName: info.name,
      },
      update: {
        token: encrypted,
        botId: String(info.id),
        botUsername: info.username ?? null,
        botName: info.name,
      },
    });

    this.logger.log(
      JSON.stringify({
        event: 'telegram.bot_connected',
        userId,
        botId: info.id,
      }),
    );

    return info;
  }

  /** Токен бота пользователя (расшифрованный) или `null`. */
  async getBotToken(userId: string): Promise<string | null> {
    const row = await this.prisma.telegramBot.findUnique({
      where: { userId },
      select: { token: true },
    });

    if (row === null) {
      return null;
    }

    return this.cipher.decrypt(row.token);
  }

  /** Отключает бота пользователя; привязки чатов остаются. */
  async disconnect(userId: string): Promise<boolean> {
    const { count } = await this.prisma.telegramBot.deleteMany({
      where: { userId },
    });

    return count > 0;
  }

  /** Состояние интеграции для раздела «Интеграции» в UI. */
  async describe(userId: string): Promise<TelegramIntegrationState> {
    const row = await this.prisma.telegramBot.findUnique({
      where: { userId },
      select: { botName: true, botUsername: true },
    });

    if (row !== null) {
      return {
        status: 'active',
        ...(row.botName === null ? {} : { botName: row.botName }),
        ...(row.botUsername === null
          ? {}
          : { botUsername: row.botUsername }),
      };
    }

    if (!this.config.isConfigured()) {
      return { status: 'disconnected' };
    }

    try {
      const info = await this.envBot();

      return {
        status: 'active',
        botName: info.name,
        ...(info.username === undefined
          ? {}
          : { botUsername: info.username }),
      };
    } catch (error) {
      return {
        status: 'error',
        error:
          error instanceof Error
            ? error.message
            : 'Telegram недоступен',
      };
    }
  }

  private async envBot(): Promise<TelegramBotInfo> {
    const cached = this.envBotCache;

    if (
      cached !== null &&
      this.now().getTime() - cached.at < ENV_BOT_CACHE_TTL_MS
    ) {
      return cached.info;
    }

    const info = await this.telegram.getMe();
    this.envBotCache = { info, at: this.now().getTime() };

    return info;
  }
}
