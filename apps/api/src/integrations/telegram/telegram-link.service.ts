import { Injectable, Logger } from '@nestjs/common';
import { invalidRequestError } from '../../common/api-error.js';
import { ChatService } from '../../chat/chat.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';

/** Привязка Telegram-чата к пользователю и диалогу. */
export interface TelegramLinkRecord {
  readonly chatId: string;
  readonly userId: string;
  readonly conversationId: string;
  readonly createdAt: Date;
}

/** Заголовок диалога, создаваемого при привязке чата. */
export function telegramConversationTitle(chatId: string): string {
  return `Telegram ${chatId}`;
}

/**
 * Привязка Telegram-чатов к пользователям SkillWharf.
 *
 * Входящее сообщение из Telegram не содержит пользователя Gateway, поэтому
 * маршрутизация идёт через `TelegramChatLink`: чат привязывается один раз
 * (`POST /integrations/telegram/link`), после чего webhook пишет в диалог
 * владельца. Один чат — один пользователь.
 */
@Injectable()
export class TelegramLinkService {
  private readonly logger = new Logger(TelegramLinkService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly chatService: ChatService,
  ) {}

  /**
   * Привязывает чат к пользователю. Повторная привязка того же чата тем же
   * пользователем идемпотентна; чужой чат перехватить нельзя.
   */
  async link(
    userId: string,
    chatId: string,
  ): Promise<TelegramLinkRecord> {
    const normalized = chatId.trim();

    if (normalized === '' || normalized.length > 128) {
      throw invalidRequestError('Telegram: некорректный chatId');
    }

    const existing = await this.prisma.telegramChatLink.findUnique({
      where: { chatId: normalized },
    });

    if (existing !== null) {
      if (existing.userId !== userId) {
        throw invalidRequestError(
          'Telegram: чат уже привязан к другому пользователю',
        );
      }

      return toRecord(existing);
    }

    const conversation = await this.chatService.createConversation(
      userId,
      telegramConversationTitle(normalized),
    );
    const created = await this.prisma.telegramChatLink.create({
      data: {
        chatId: normalized,
        userId,
        conversationId: conversation.id,
      },
    });

    this.logger.log(
      JSON.stringify({
        event: 'telegram.chat_linked',
        userId,
        chatId: normalized,
        conversationId: conversation.id,
      }),
    );

    return toRecord(created);
  }

  /** Удаляет привязку; чужая привязка не удаляется. */
  async unlink(userId: string, chatId: string): Promise<boolean> {
    const { count } = await this.prisma.telegramChatLink.deleteMany({
      where: { chatId: chatId.trim(), userId },
    });

    return count > 0;
  }

  /** Привязка по chat_id для webhook. */
  async findByChatId(chatId: string): Promise<TelegramLinkRecord | null> {
    const row = await this.prisma.telegramChatLink.findUnique({
      where: { chatId },
    });

    return row === null ? null : toRecord(row);
  }

  /** Все привязки пользователя (для UI/диагностики). */
  async listForUser(userId: string): Promise<TelegramLinkRecord[]> {
    const rows = await this.prisma.telegramChatLink.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    return rows.map(toRecord);
  }
}

function toRecord(row: {
  chatId: string;
  userId: string;
  conversationId: string;
  createdAt: Date;
}): TelegramLinkRecord {
  return {
    chatId: row.chatId,
    userId: row.userId,
    conversationId: row.conversationId,
    createdAt: row.createdAt,
  };
}
