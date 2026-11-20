import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import type { TelegramChannel } from '@prisma/client';
import { policyBlockedError, providerNotConfiguredError } from '../common/api-error.js';
import { TokenCipherService } from '../integrations/google/token-cipher.service.js';
import { TelegramService } from '../integrations/telegram/telegram.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { WorkspacesService } from '../workspaces/workspaces.service.js';
import {
  createTelegramChannelSchema,
  telegramChannelViewSchema,
  type CreatedTelegramChannel,
  type TelegramChannelView,
} from './telegram-channels.schemas.js';

/** Маскировка токена: наружу уходят только последние 4 символа. */
export function maskBotToken(token: string): string {
  return token.length <= 8 ? '********' : `****${token.slice(-4)}`;
}

/** Подключение Telegram-ботов к воркспейсу (OMNI-39.1). */
@Injectable()
export class TelegramChannelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: TokenCipherService,
    private readonly telegram: TelegramService,
    private readonly workspaces: WorkspacesService,
    @Optional() private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async list(
    userId: string,
    workspaceId: string,
  ): Promise<TelegramChannelView[]> {
    await this.assertManager(userId, workspaceId);
    const rows = await this.prisma.telegramChannel.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });

    return rows.map((row) => this.toView(row));
  }

  async create(
    userId: string,
    workspaceId: string,
    raw: unknown,
  ): Promise<CreatedTelegramChannel> {
    await this.assertManager(userId, workspaceId);
    const input = createTelegramChannelSchema.parse(raw);
    const id = randomUUID();
    const webhookSecret = randomBytes(32).toString('base64url');
    const webhookPath = `/api/v1/webhooks/telegram/${id}`;
    const skipApiCalls = this.env.TELEGRAM_SKIP_API_CALLS === 'true';

    let botUsername: string | null = null;

    if (!skipApiCalls) {
      const info = await this.telegram.getMe(input.botToken);
      const baseUrl = this.env.TELEGRAM_WEBHOOK_BASE_URL?.trim() ?? '';

      if (baseUrl === '') {
        throw providerNotConfiguredError(
          'Подключение Telegram требует TELEGRAM_WEBHOOK_BASE_URL',
        );
      }

      botUsername = info.username ?? null;
      await this.telegram.setWebhook(
        `${baseUrl.replace(/\/+$/, '')}${webhookPath}`,
        webhookSecret,
      );
    }

    const row = await this.prisma.telegramChannel.create({
      data: {
        id,
        workspaceId,
        userId,
        botUsername,
        encryptedBotToken: this.cipher.encrypt(input.botToken),
        webhookSecret,
        allowedChatIds: (input.allowedChatIds ?? []).map((chatId) =>
          String(chatId),
        ),
      },
    });

    return { ...this.toView(row), webhookSecret };
  }

  async remove(
    userId: string,
    workspaceId: string,
    channelId: string,
  ): Promise<{ id: string }> {
    await this.assertManager(userId, workspaceId);
    const row = await this.prisma.telegramChannel.findFirst({
      where: { id: channelId, workspaceId },
    });

    if (row === null) {
      throw new NotFoundException('Telegram-канал не найден');
    }

    await this.prisma.telegramChannel.delete({ where: { id: channelId } });

    return { id: channelId };
  }

  /** Только для внутреннего вебхук-шлюза: секрет и зашифрованный токен. */
  async findForWebhook(channelId: string): Promise<TelegramChannel | null> {
    return this.prisma.telegramChannel.findUnique({
      where: { id: channelId },
    });
  }

  /** Расшифрованный токен — только для исходящих вызовов Bot API. */
  decryptToken(row: TelegramChannel): string {
    return this.cipher.decrypt(row.encryptedBotToken);
  }

  async touch(channelId: string): Promise<void> {
    await this.prisma.telegramChannel.update({
      where: { id: channelId },
      data: { lastMessageAt: new Date() },
    });
  }

  private async assertManager(
    userId: string,
    workspaceId: string,
  ): Promise<void> {
    const active = await this.workspaces.resolveActive(userId, workspaceId);

    if (active === null) {
      throw policyBlockedError('Нет доступа к воркспейсу');
    }

    await this.workspaces.assertRole(userId, this.workspaces.managerRoles(), workspaceId);
  }

  private toView(row: TelegramChannel): TelegramChannelView {
    let tokenMasked = '********';

    try {
      tokenMasked = maskBotToken(this.cipher.decrypt(row.encryptedBotToken));
    } catch {
      // неверный ключ/delegate не должен ломать список — токен не раскрываем
    }

    return telegramChannelViewSchema.parse({
      id: row.id,
      workspaceId: row.workspaceId,
      userId: row.userId,
      botUsername: row.botUsername,
      tokenMasked,
      webhookUrl: `/api/v1/webhooks/telegram/${row.id}`,
      allowedChatIds: row.allowedChatIds,
      isActive: row.isActive,
      lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    });
  }
}
