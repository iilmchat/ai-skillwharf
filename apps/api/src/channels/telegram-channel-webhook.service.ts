import { Injectable, Logger } from '@nestjs/common';
import { invalidRequestError } from '../common/api-error.js';
import { ChatService } from '../chat/chat.service.js';
import {
  sttRequestSchema,
  SpeechToTextService,
} from '../chat/speech-to-text.service.js';
import {
  messageText,
  normalizeChatId,
  telegramUpdateSchema,
  type TelegramCallbackQuery,
  type TelegramMessage,
} from '../integrations/telegram/telegram.schemas.js';
import { TelegramService } from '../integrations/telegram/telegram.service.js';
import { safeEqual } from '../integrations/telegram/telegram-webhook.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TelegramChannelsService } from './telegram-channels.service.js';
import { parseHitlCallback } from './telegram-channels.schemas.js';

const HITL_PROMPT = 'Действие требует подтверждения. Выберите решение:';
const APPROVED_TEXT = '✅ Действие одобрено';
const REJECTED_TEXT = '❌ Действие отклонено';
const EXPIRED_TEXT = 'Запрос на подтверждение устарел или уже обработан.';

/**
 * Публичный шлюз Telegram updates для подключённых каналов (OMNI-39.2/HITL-39.3).
 */
@Injectable()
export class TelegramChannelWebhookService {
  private readonly logger = new Logger(TelegramChannelWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly channels: TelegramChannelsService,
    private readonly telegram: TelegramService,
    private readonly chat: ChatService,
    private readonly speech: SpeechToTextService,
  ) {}

  async handle(
    channelId: string,
    secretHeader: string | undefined,
    body: unknown,
  ): Promise<{ ok: true }> {
    const channel = await this.channels.findForWebhook(channelId);

    if (channel === null || !channel.isActive) {
      throw invalidRequestError('Telegram-канал не найден или отключён');
    }

    if (
      secretHeader === undefined ||
      !safeEqual(secretHeader, channel.webhookSecret)
    ) {
      throw invalidRequestError('Неверный X-Telegram-Bot-Api-Secret-Token');
    }

    const parsed = telegramUpdateSchema.safeParse(body);

    if (!parsed.success) {
      throw invalidRequestError('Telegram webhook: некорректный update');
    }

    const update = parsed.data;
    const callback = update.callback_query;
    const chatId = normalizeChatId(
      callback?.message?.chat.id ??
        update.message?.chat.id ??
        update.edited_message?.chat.id ??
        0,
    );

    if (chatId === '0') {
      return { ok: true };
    }

    await this.allowChat(channelId, channel.allowedChatIds, chatId);
    const botToken = this.channels.decryptToken(channel);

    if (callback !== undefined) {
      await this.handleCallback(botToken, channel.userId, chatId, callback);
    } else {
      const message = update.message ?? update.edited_message;

      if (message !== undefined) {
        await this.handleMessage(botToken, channel.userId, chatId, message);
      }
    }

    await this.channels.touch(channelId);

    return { ok: true };
  }

  /** Пустой список — автоматически привязываем первый написавший чат. */
  private async allowChat(
    channelId: string,
    allowedChatIds: readonly string[],
    chatId: string,
  ): Promise<void> {
    if (allowedChatIds.length === 0) {
      await this.prisma.telegramChannel.update({
        where: { id: channelId },
        data: { allowedChatIds: [chatId] },
      });

      return;
    }

    if (!allowedChatIds.includes(chatId)) {
      throw invalidRequestError('Чат не входит в белый список канала');
    }
  }

  private async handleMessage(
    botToken: string,
    userId: string,
    chatId: string,
    message: TelegramMessage,
  ): Promise<void> {
    const prompt = await this.toPrompt(botToken, message);

    if (prompt === null) {
      await this.send(botToken, chatId, 'Не удалось распознать сообщение.');
      return;
    }

    const conversation = await this.prisma.conversation.create({
      data: { userId, title: `Telegram ${chatId}` },
    });
    const reply = await this.chat.handleMessage(
      userId,
      conversation.id,
      prompt,
    );

    if (reply.pendingApproval === true) {
      await this.telegram.sendMessage({
        chatId,
        text: HITL_PROMPT,
        botToken,
        buttons: [
          {
            text: '✅ Одобрить',
            callbackData: `hitl:approve:${conversation.id}`,
          },
          {
            text: '❌ Отклонить',
            callbackData: `hitl:reject:${conversation.id}`,
          },
        ],
      });

      return;
    }

    if (reply.reply.trim() !== '') {
      await this.send(botToken, chatId, reply.reply);
    }
  }

  private async toPrompt(
    botToken: string,
    message: TelegramMessage,
  ): Promise<string | null> {
    const text = messageText(message);

    if (text !== null) {
      return text;
    }

    if (message.voice !== undefined) {
      const filePath = await this.telegram.getFile(
        message.voice.file_id,
        botToken,
      );
      const audio = await this.telegram.downloadFile(filePath, botToken);
      const transcript = await this.speech.transcribe(
        sttRequestSchema.parse({
          audioBase64: audio.toString('base64'),
          mimeType: message.voice.mime_type ?? 'audio/ogg',
        }),
      );

      return `Распознанное голосовое сообщение: ${transcript.text}`;
    }

    if (message.photo !== undefined && message.photo.length > 0) {
      const largest = message.photo[message.photo.length - 1]!;

      return [
        'Входящее изображение документа (накладной).',
        `Метаданные: file_id=${largest.file_id}, ${largest.width}x${largest.height}.`,
        ...(message.caption === undefined ? [] : [`Подпись: ${message.caption}`]),
      ].join('\n');
    }

    return null;
  }

  private async handleCallback(
    botToken: string,
    userId: string,
    chatId: string,
    callback: TelegramCallbackQuery,
  ): Promise<void> {
    const decision = parseHitlCallback(callback.data);

    await this.telegram.answerCallbackQuery(callback.id, 'Принято');

    if (decision === null || callback.message === undefined) {
      return;
    }

    const conversation = await this.prisma.conversation.findFirst({
      where: { id: decision.runId, userId },
      select: { id: true },
    });

    if (conversation === null) {
      await this.edit(
        botToken,
        chatId,
        callback.message.message_id,
        EXPIRED_TEXT,
      );

      return;
    }

    const reply = await this.chat.approveAction(
      userId,
      conversation.id,
      decision.action === 'approve',
    );
    const text =
      reply === null
        ? EXPIRED_TEXT
        : `${decision.action === 'approve' ? APPROVED_TEXT : REJECTED_TEXT}\n${reply.reply}`.trim();

    await this.edit(botToken, chatId, callback.message.message_id, text);
  }

  private async send(
    botToken: string,
    chatId: string,
    text: string,
  ): Promise<void> {
    try {
      await this.telegram.sendText(chatId, text, { botToken });
    } catch (error) {
      this.logger.warn(
        `Telegram: не удалось отправить ответ: ${String(error)}`,
      );
    }
  }

  private async edit(
    botToken: string,
    chatId: string,
    messageId: number,
    text: string,
  ): Promise<void> {
    try {
      await this.telegram.editMessageText({
        chatId,
        messageId,
        text,
        botToken,
      });
    } catch (error) {
      this.logger.warn(
        `Telegram: не удалось обновить сообщение: ${String(error)}`,
      );
    }
  }
}
