import { Injectable } from '@nestjs/common';
import { invalidRequestError } from '../common/api-error.js';
import { ChatService } from '../chat/chat.service.js';
import { safeEqual } from '../integrations/telegram/telegram-webhook.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CorpChannelsService } from './corp-channels.service.js';

const HITL_PROMPT = 'Действие требует подтверждения. Выберите решение:';

/** Публичный приёмник сообщений корпоративных мессенджеров (OMNI-40.1). */
@Injectable()
export class CorpWebhookService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly channels: CorpChannelsService,
    private readonly chat: ChatService,
  ) {}

  async handle(
    channelId: string,
    secret: string | undefined,
    headers: Readonly<Record<string, string>>,
    body: unknown,
  ): Promise<{ ok: true }> {
    const channel = await this.channels.findForWebhook(channelId);

    if (channel === null || !channel.isActive) {
      throw invalidRequestError('Канал мессенджера не найден или отключён');
    }

    if (secret === undefined || !safeEqual(secret, channel.webhookSecret)) {
      throw invalidRequestError('Неверный X-Webhook-Secret');
    }

    const adapter = this.channels.adapters.get(channel.provider);
    const message = adapter.parseIncomingWebhook(body, headers);

    if (message === null) {
      throw invalidRequestError('Некорректное входящее событие мессенджера');
    }

    await this.allowChat(channelId, channel.allowedChatIds, message.chatId);
    const token = this.channels.decryptToken(channel);
    const send = (text: string, hitlRunId?: string) =>
      adapter.sendTextMessage({
        baseUrl: channel.apiBaseUrl,
        token,
        chatId: message.chatId,
        text,
        ...(hitlRunId === undefined ? {} : { hitlRunId }),
      });

    if (message.hitl !== undefined) {
      await this.handleHitl(channel.userId, message.hitl, send);
    } else {
      const conversation = await this.prisma.conversation.create({
        data: { userId: channel.userId, title: `${channel.provider} ${message.chatId}` },
      });
      const reply = await this.chat.handleMessage(
        channel.userId,
        conversation.id,
        message.text,
      );

      if (reply.pendingApproval === true) {
        await send(HITL_PROMPT, conversation.id);
      } else if (reply.reply.trim() !== '') {
        await send(reply.reply);
      }
    }

    await this.channels.touch(channelId);

    return { ok: true };
  }

  /** Пустой список привязывает первый написавший чат. */
  private async allowChat(
    channelId: string,
    allowedChatIds: readonly string[],
    chatId: string,
  ): Promise<void> {
    if (allowedChatIds.length === 0) {
      await this.prisma.corpMessengerChannel.update({
        where: { id: channelId },
        data: { allowedChatIds: [chatId] },
      });

      return;
    }

    if (!allowedChatIds.includes(chatId)) {
      throw invalidRequestError('Чат не входит в белый список канала');
    }
  }

  private async handleHitl(
    userId: string,
    decision: { action: 'approve' | 'reject'; runId: string },
    send: (text: string) => Promise<void>,
  ): Promise<void> {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: decision.runId, userId },
      select: { id: true },
    });

    if (conversation === null) {
      await send('Запрос на подтверждение устарел или уже обработан.');

      return;
    }

    const reply = await this.chat.approveAction(
      userId,
      decision.runId,
      decision.action === 'approve',
    );

    await send(
      reply === null
        ? 'Запрос на подтверждение устарел или уже обработан.'
        : `${decision.action === 'approve' ? '✅ Одобрено' : '❌ Отклонено'}\n${reply.reply}`.trim(),
    );
  }
}
