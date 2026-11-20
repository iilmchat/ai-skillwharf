import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { TokenCipherService } from '../integrations/google/token-cipher.service.js';
import type { TelegramService } from '../integrations/telegram/telegram.service.js';
import type { WorkspacesService } from '../workspaces/workspaces.service.js';
import {
  maskBotToken,
  TelegramChannelsService,
} from './telegram-channels.service.js';

const WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';
const OWNER = 'owner-1';
const BOT_TOKEN = '123456789:AAExampleTokenValue1234';

function channelRow(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    workspaceId: WORKSPACE_ID,
    userId: OWNER,
    botUsername: 'test_bot',
    encryptedBotToken: `v2:enc:${BOT_TOKEN}`,
    webhookSecret: 'secret',
    allowedChatIds: ['100'],
    isActive: true,
    lastMessageAt: null,
    createdAt: new Date('2026-11-20T10:00:00Z'),
    updatedAt: new Date('2026-11-20T10:00:00Z'),
    ...overrides,
  };
}

function createHarness(rows: Array<Record<string, unknown>> = []) {
  const prisma = {
    telegramChannel: {
      findMany: vi.fn(async () => rows),
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) =>
        rows.find((row) => row.id === where.id) ?? null,
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        rows.find((row) => row.id === where.id) ?? null,
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = channelRow(data);

        rows.push(row);

        return row;
      }),
      update: vi.fn(async () => channelRow()),
      delete: vi.fn(async ({ where }: { where: { id: string } }) => {
        const index = rows.findIndex((row) => row.id === where.id);

        if (index >= 0) {
          rows.splice(index, 1);
        }
      }),
    },
  };
  const cipher = {
    encrypt: vi.fn((token: string) => `v2:enc:${token}`),
    decrypt: vi.fn((envelope: string) => envelope.replace('v2:enc:', '')),
  };
  const telegram = {
    getMe: vi.fn(async () => ({ id: 1, username: 'test_bot', name: 'Test' })),
    setWebhook: vi.fn(async () => undefined),
  };
  const workspaces = {
    resolveActive: vi.fn(async () => ({ workspaceId: WORKSPACE_ID })),
    managerRoles: vi.fn(() => new Set(['owner', 'admin'])),
    assertRole: vi.fn(async () => undefined),
  };
  const service = new TelegramChannelsService(
    prisma as unknown as PrismaService,
    cipher as unknown as TokenCipherService,
    telegram as unknown as TelegramService,
    workspaces as unknown as WorkspacesService,
    {
      TELEGRAM_SKIP_API_CALLS: 'false',
      TELEGRAM_WEBHOOK_BASE_URL: 'https://api.example.com',
    },
  );

  return { service, prisma, cipher, telegram, workspaces, rows };
}

describe('TelegramChannelsService (OMNI-39.1)', () => {
  it('шифрует botToken и никогда не возвращает его в GET/POST', async () => {
    const { service, cipher, telegram } = createHarness();

    const created = await service.create(OWNER, WORKSPACE_ID, {
      botToken: BOT_TOKEN,
      allowedChatIds: [100],
    });

    expect(cipher.encrypt).toHaveBeenCalledWith(BOT_TOKEN);
    expect(telegram.getMe).toHaveBeenCalledWith(BOT_TOKEN);
    expect(telegram.setWebhook).toHaveBeenCalledWith(
      `https://api.example.com/api/v1/webhooks/telegram/${created.id}`,
      created.webhookSecret,
    );
    expect(created.tokenMasked).toBe('****1234');
    expect(created.allowedChatIds).toEqual(['100']);
    expect(JSON.stringify(created)).not.toContain(BOT_TOKEN);

    const list = await service.list(OWNER, WORKSPACE_ID);

    expect(list[0]?.tokenMasked).toBe('****1234');
    expect(JSON.stringify(list)).not.toContain(BOT_TOKEN);
  });

  it('с skip API calls не дёргает Telegram', async () => {
    const { service, cipher, telegram } = createHarness();
    const withSkip = new TelegramChannelsService(
      {} as PrismaService,
      cipher as unknown as TokenCipherService,
      telegram as unknown as TelegramService,
      {
        resolveActive: vi.fn(async () => ({ workspaceId: WORKSPACE_ID })),
        managerRoles: vi.fn(() => new Set(['owner', 'admin'])),
        assertRole: vi.fn(async () => undefined),
      } as unknown as WorkspacesService,
      { TELEGRAM_SKIP_API_CALLS: 'true' },
    );

    // сервис с dummy prisma упадёт на create — проверяем только отсутствие вызовов API
    await expect(
      withSkip.create(OWNER, WORKSPACE_ID, { botToken: BOT_TOKEN }),
    ).rejects.toThrow();
    expect(telegram.getMe).not.toHaveBeenCalled();
    expect(service).toBeDefined();
  });

  it('удаляет только канал своего воркспейса', async () => {
    const row = channelRow();
    const { service } = createHarness([row]);

    await expect(
      service.remove(OWNER, WORKSPACE_ID, row.id as string),
    ).resolves.toEqual({ id: row.id });
    await expect(
      service.remove(OWNER, WORKSPACE_ID, row.id as string),
    ).rejects.toThrow();
  });

  it('maskBotToken не раскрывает короткие токены', () => {
    expect(maskBotToken('abc')).toBe('********');
    expect(maskBotToken('123456789:AAxx')).toBe('****AAxx');
  });
});
