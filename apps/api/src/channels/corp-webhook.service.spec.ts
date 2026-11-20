import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ChatService } from '../chat/chat.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { CorpChannelsService } from './corp-channels.service.js';
import { CorpWebhookService } from './corp-webhook.service.js';

const CHANNEL_ID = randomUUID();
const CONVERSATION_ID = randomUUID();
const SECRET = 'corp-webhook-secret';
const RUN_ID = randomUUID();

function createHarness(allowedChatIds: string[] = ['42']) {
  const channel = {
    id: CHANNEL_ID,
    userId: 'owner-1',
    provider: 'vk_teams',
    apiBaseUrl: null,
    encryptedBotToken: 'v2:enc:token',
    webhookSecret: SECRET,
    allowedChatIds,
    isActive: true,
  };
  const adapter = {
    provider: 'vk_teams',
    parseIncomingWebhook: vi.fn((payload: unknown) => {
      const input = payload as {
        type?: string;
        chat?: { chatId?: number | string };
        text?: string;
        callback_data?: string;
      };

      if (input.type === 'callbackQuery') {
        return {
          chatId: '42',
          text: '',
          hitl: { action: 'approve', runId: RUN_ID },
        };
      }

      return { chatId: '42', text: input.text ?? '' };
    }),
    sendTextMessage: vi.fn(async () => undefined),
  };
  const prisma = {
    corpMessengerChannel: {
      update: vi.fn(async () => channel),
    },
    conversation: {
      create: vi.fn(async () => ({ id: CONVERSATION_ID })),
      findFirst: vi.fn(async () => ({ id: CONVERSATION_ID })),
    },
  };
  const channels = {
    findForWebhook: vi.fn(async () => channel),
    decryptToken: vi.fn(() => 'plain-token'),
    touch: vi.fn(async () => undefined),
    adapters: { get: vi.fn(() => adapter) },
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
  const service = new CorpWebhookService(
    prisma as unknown as PrismaService,
    channels as unknown as CorpChannelsService,
    chat as unknown as ChatService,
  );

  return { service, adapter, prisma, chat, channels };
}

describe('CorpWebhookService (OMNI-40.1/HITL)', () => {
  const payload = { type: 'newMessage', chat: { chatId: 42 }, text: 'привет' };

  it('отвергает неверный секрет', async () => {
    const { service, adapter } = createHarness();

    await expect(
      service.handle(CHANNEL_ID, 'wrong', {}, payload),
    ).rejects.toThrow();
    expect(adapter.sendTextMessage).not.toHaveBeenCalled();
  });

  it('фильтрует чаты по allowedChatIds', async () => {
    const { service, chat } = createHarness(['999']);

    await expect(
      service.handle(CHANNEL_ID, SECRET, {}, payload),
    ).rejects.toThrow();
    expect(chat.handleMessage).not.toHaveBeenCalled();
  });

  it('запускает ChatService и отправляет ответ через адаптер', async () => {
    const { service, adapter, chat } = createHarness();

    await expect(
      service.handle(CHANNEL_ID, SECRET, {}, payload),
    ).resolves.toEqual({ ok: true });
    expect(chat.handleMessage).toHaveBeenCalledWith(
      'owner-1',
      CONVERSATION_ID,
      'привет',
    );
    expect(adapter.sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Ответ агента', token: 'plain-token' }),
    );
  });

  it('при pendingApproval отправляет кнопки через адаптер', async () => {
    const { service, adapter, chat } = createHarness();
    chat.handleMessage.mockResolvedValue({
      conversationId: CONVERSATION_ID,
      reply: '',
      pendingApproval: true,
    });

    await service.handle(CHANNEL_ID, SECRET, {}, payload);

    expect(adapter.sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ hitlRunId: CONVERSATION_ID }),
    );
  });

  it('callback approve подтверждает действие', async () => {
    const { service, adapter, chat } = createHarness();

    await service.handle(CHANNEL_ID, SECRET, {}, {
      type: 'callbackQuery',
      callback_data: `hitl:approve:${RUN_ID}`,
    });

    expect(chat.approveAction).toHaveBeenCalledWith(
      'owner-1',
      RUN_ID,
      true,
    );
    expect(adapter.sendTextMessage).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Одобрено') }),
    );
  });
});
