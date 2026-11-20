import { Injectable, NotFoundException } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import type { CorpMessengerChannel } from '@prisma/client';
import { policyBlockedError } from '../common/api-error.js';
import { TokenCipherService } from '../integrations/google/token-cipher.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { WorkspacesService } from '../workspaces/workspaces.service.js';
import { CorpMessengerAdapterRegistry } from './adapters/corp-messenger.registry.js';
import {
  createCorpChannelSchema,
  corpChannelViewSchema,
  type CorpChannelView,
  type CreatedCorpChannel,
} from './corp-channels.schemas.js';

/** Маскировка токена: наружу уходят только последние 4 символа. */
export function maskCorpToken(token: string): string {
  return token.length <= 8 ? '********' : `****${token.slice(-4)}`;
}

/** CRUD подключений корпоративных мессенджеров (OMNI-40.1/40.2). */
@Injectable()
export class CorpChannelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: TokenCipherService,
    private readonly workspaces: WorkspacesService,
    readonly adapters: CorpMessengerAdapterRegistry,
  ) {}

  async list(
    userId: string,
    workspaceId: string,
  ): Promise<CorpChannelView[]> {
    await this.assertManager(userId, workspaceId);
    const rows = await this.prisma.corpMessengerChannel.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });

    return rows.map((row) => this.toView(row));
  }

  async create(
    userId: string,
    workspaceId: string,
    raw: unknown,
  ): Promise<CreatedCorpChannel> {
    await this.assertManager(userId, workspaceId);
    const input = createCorpChannelSchema.parse(raw);
    const id = randomUUID();
    const webhookSecret = randomBytes(32).toString('base64url');
    const row = await this.prisma.corpMessengerChannel.create({
      data: {
        id,
        workspaceId,
        userId,
        provider: input.provider,
        name: input.name,
        apiBaseUrl: input.apiBaseUrl ?? null,
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
    const row = await this.prisma.corpMessengerChannel.findFirst({
      where: { id: channelId, workspaceId },
    });

    if (row === null) {
      throw new NotFoundException('Канал мессенджера не найден');
    }

    await this.prisma.corpMessengerChannel.delete({ where: { id: channelId } });

    return { id: channelId };
  }

  /** Только для внутреннего вебхук-шлюза. */
  async findForWebhook(
    channelId: string,
  ): Promise<CorpMessengerChannel | null> {
    return this.prisma.corpMessengerChannel.findUnique({
      where: { id: channelId },
    });
  }

  decryptToken(row: CorpMessengerChannel): string {
    return this.cipher.decrypt(row.encryptedBotToken);
  }

  async touch(channelId: string): Promise<void> {
    await this.prisma.corpMessengerChannel.update({
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

    await this.workspaces.assertRole(
      userId,
      this.workspaces.managerRoles(),
      workspaceId,
    );
  }

  private toView(row: CorpMessengerChannel): CorpChannelView {
    let tokenMasked = '********';

    try {
      tokenMasked = maskCorpToken(this.cipher.decrypt(row.encryptedBotToken));
    } catch {
      // неверный ключ/delegate не должен ломать список — токен не раскрываем
    }

    return corpChannelViewSchema.parse({
      id: row.id,
      workspaceId: row.workspaceId,
      userId: row.userId,
      provider: row.provider,
      name: row.name,
      apiBaseUrl: row.apiBaseUrl,
      tokenMasked,
      webhookUrl: `/api/v1/webhooks/corporate/${row.id}`,
      allowedChatIds: row.allowedChatIds,
      isActive: row.isActive,
      lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    });
  }
}
