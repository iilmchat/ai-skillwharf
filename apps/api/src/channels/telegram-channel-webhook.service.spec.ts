import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ChatService } from '../chat/chat.service.js';
import type { SpeechToTextService } from '../chat/speech-to-text.service.js';
import type { TelegramService } from '../integrations/telegram/telegram.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { TelegramChannelWebhookService } from './telegram-channel-webhook.service.js';
import type { TelegramChannelsService } from './telegram-channels.service.js';

const CHANNEL_ID = randomUUID();
const CONVERSATION_ID = randomUUID();
const SECRET = 'super-secret';

function baseUpdate(overrides: Record<string, unknown> = {}) {
  return { update_id: 1, ...overrides };
}

function createHarness(allowedChatIds: string[] = ['100']) {
  const channel = {
    id: CHANNEL_ID,
    userId: 'owner-1',
    encryptedBotToken: 'v2:enc:token',
    webhookSecret: SECRET,
    allowedChatIds,
    isActive: true,
  };
  const prisma = {
    telegramChannel: {
      update: vi.fn(async () => channel),
    },
    conversation: {
      create: vi.fn(async () => ({ id: CONVERSATION_ID })),
      findFirst: vi.fn(async () => ({ id: CONVERSATION_ID })),
    },
  };
  const channels = {
    findForWebhook: vi.fn(async () => channel),
    decryptToken: vi.fn(() => 'plain-bot-token'),
    touch: vi.fn(async () => undefined),
  };
  const telegram = {
    sendText: vi.fn(async () => ({ messageId: 1, chatId: '100' })),
    sendMessage: vi.fn(async () => ({ messageId: 2, chatId: '100' })),
    answerCallbackQuery: vi.fn(async () => undefined),
    editMessageText: vi.fn(async () => undefined),
    getFile: vi.fn(async () => 'voice.oga'),
    downloadFile: vi.fn(async () => Buffer.from('ogg-audio')),
  };
  const chat = {
    handleMessage: vi.fn(async () => ({
      conversationId: CONVERSATION_ID,
      reply: 'Ответ агента',
    })),
    approveAction: vi.fn(async () => ({
      conversationId: CONVERSATION_ID,
      reply: 'Готово',
    })),
  };
  const speech = {
    transcribe: vi.fn(async () => ({
      text: 'распознанный вопрос',
      provider: 'mock',
    })),
  };
  const service = new TelegramChannelWebhookService(
    prisma as unknown as PrismaService,
    channels as unknown as TelegramChannelsService,
    telegram as unknown as TelegramService,
    chat as unknown as ChatService,
    speech as unknown as SpeechToTextService,
  );

  return { service, prisma, channels, telegram, chat, speech };
}

describe('TelegramChannelWebhookService (OMNI-39.2/HITL-39.3)', () => {
  it('отвергает неверный secret token', async () => {
    const { service, telegram } = createHarness();

    await expect(
      service.handle(CHANNEL_ID, 'wrong', baseUpdate()),
    ).rejects.toThrow();
    expect(telegram.sendText).not.toHaveBeenCalled();
  });

  it('отвергает чат вне белого списка', async () => {
    const { service, chat } = createHarness(['999']);

    await expect(
      service.handle(
        CHANNEL_ID,
        SECRET,
        baseUpdate({
          message: { message_id: 1, chat: { id: 100 }, text: 'привет' },
        }),
      ),
    ).rejects.toThrow();
    expect(chat.handleMessage).not.toHaveBeenCalled();
  });

  it('обрабатывает текстовое сообщение и отправляет ответ', async () => {
    const { service, chat, telegram } = createHarness();

    const result = await service.handle(
      CHANNEL_ID,
      SECRET,
      baseUpdate({
        message: { message_id: 1, chat: { id: 100 }, text: 'сколько стоит?' },
      }),
    );

    expect(result).toEqual({ ok: true });
    expect(chat.handleMessage).toHaveBeenCalledWith(
      'owner-1',
      CONVERSATION_ID,
      'сколько стоит?',
    );
    expect(telegram.sendText).toHaveBeenCalledWith(
      '100',
      'Ответ агента',
      expect.objectContaining({ botToken: 'plain-bot-token' }),
    );
  });

  it('скачивает голос, транскрибирует и шлёт запрос агенту', async () => {
    const { service, chat, speech, telegram } = createHarness();

    await service.handle(
      CHANNEL_ID,
      SECRET,
      baseUpdate({
        message: {
          message_id: 1,
          chat: { id: 100 },
          voice: { file_id: 'voice-file', duration: 3 },
        },
      }),
    );

    expect(telegram.getFile).toHaveBeenCalledWith(
      'voice-file',
      'plain-bot-token',
    );
    expect(telegram.downloadFile).toHaveBeenCalledWith(
      'voice.oga',
      'plain-bot-token',
    );
    expect(speech.transcribe).toHaveBeenCalledWith(
      expect.objectContaining({ mimeType: 'audio/ogg' }),
    );
    expect(chat.handleMessage).toHaveBeenCalledWith(
      'owner-1',
      CONVERSATION_ID,
      'Распознанное голосовое сообщение: распознанный вопрос',
    );
  });

  it('отправляет inline-кнопки при pendingApproval', async () => {
    const { service, chat, telegram } = createHarness();
    chat.handleMessage.mockResolvedValue({
      conversationId: CONVERSATION_ID,
      reply: '',
      pendingApproval: true,
    });

    await service.handle(
      CHANNEL_ID,
      SECRET,
      baseUpdate({
        message: { message_id: 1, chat: { id: 100 }, text: 'одобри платёж' },
      }),
    );

    const call = telegram.sendMessage.mock.calls[0]?.[0] as {
      buttons: Array<{ text: string; callbackData: string }>;
    };

    expect(call.buttons.map((button) => button.callbackData)).toEqual([
      `hitl:approve:${CONVERSATION_ID}`,
      `hitl:reject:${CONVERSATION_ID}`,
    ]);
    expect(call.buttons.map((button) => button.text)).toEqual([
      '✅ Одобрить',
      '❌ Отклонить',
    ]);
  });

  for (const action of ['approve', 'reject'] as const) {
    it(`callback_query hitl:${action} подтверждает/отклоняет и обновляет сообщение`, async () => {
      const { service, chat, telegram } = createHarness();

      await service.handle(
        CHANNEL_ID,
        SECRET,
        baseUpdate({
          callback_query: {
            id: 'cb-1',
            from: { id: 100 },
            data: `hitl:${action}:${CONVERSATION_ID}`,
            message: { message_id: 7, chat: { id: 100 } },
          },
        }),
      );

      expect(chat.approveAction).toHaveBeenCalledWith(
        'owner-1',
        CONVERSATION_ID,
        action === 'approve',
      );
      expect(telegram.answerCallbackQuery).toHaveBeenCalledWith(
        'cb-1',
        'Принято',
      );
      expect(telegram.editMessageText).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 7 }),
      );
    });
  }
});
