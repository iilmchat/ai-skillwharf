import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ChatService } from '../chat/chat.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { secretMatches, TriggersService } from './triggers.service.js';

const SECRET = 's3cr3t-token';

function harness() {
  const record = {
    id: 'trigger-1',
    workspaceId: 'ws-1',
    userId: 'user-1',
    name: 'Битрикс24: новая сделка',
    slug: 'trigger-slug',
    source: 'bitrix24',
    secretToken: SECRET,
    promptTemplate: 'Сделка: {{payload}}. Источник: {{source}}',
    isActive: true,
    lastTriggeredAt: null,
    triggerCount: 0,
    createdAt: new Date('2026-11-19T00:00:00Z'),
  };
  const prisma = {
    webhookTrigger: {
      findMany: vi.fn(async () => [record]),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => ({
        ...record,
        ...args.data,
      })),
      findUnique: vi.fn(async ({ where }: { where: { slug: string } }) =>
        where.slug === record.slug ? record : null,
      ),
      update: vi.fn(async () => ({ ...record, triggerCount: 1 })),
      delete: vi.fn(async () => record),
    },
    conversation: {
      create: vi.fn(async () => ({ id: 'conv-1' })),
    },
    message: {
      create: vi.fn(async () => ({ id: 'msg-1' })),
    },
  };
  const chat = {
    handleMessage: vi.fn(async () => ({
      conversationId: 'conv-1',
      reply: 'готово',
    })),
  };
  const service = new TriggersService(
    prisma as unknown as PrismaService,
    chat as unknown as ChatService,
  );

  return { service, prisma, chat, record };
}

/**
 * Зеркало UI-контракта из `apps/web/src/lib/triggers.ts` (только чтение):
 * карточка требует promptTemplate/status, ответ создания — secret.
 */
const uiTriggerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  source: z.enum(['bitrix24', 'moysklad', '1c', 'custom']),
  promptTemplate: z.string().min(1),
  slug: z.string().min(1),
  triggerCount: z.number().int().nonnegative().default(0),
  status: z.enum(['active', 'paused']).default('active'),
  createdAt: z.string().nullable().optional(),
});
const uiCreatedTriggerSchema = uiTriggerSchema.extend({
  secret: z.string().min(1),
  webhookUrl: z.string().nullable().optional(),
});

describe('TriggersService (CONNECT-32.2)', () => {
  it('создаёт триггер с криптостойким slug и secretToken', async () => {
    const { service, prisma } = harness();
    const created = await service.create('user-1', 'ws-1', {
      name: 'МойСклад: остатки',
      source: 'moysklad',
      promptTemplate: 'Проверь остатки {{payload}}',
    });

    const data = (prisma.webhookTrigger.create.mock.calls[0] as [
      { data: Record<string, unknown> },
    ])[0].data;

    expect(created.slug).toMatch(/^[a-z0-9-]{16,24}$/);
    expect(typeof data.secretToken).toBe('string');
    expect(String(data.secretToken).length).toBeGreaterThan(32);
    expect(data).toMatchObject({ userId: 'user-1', workspaceId: 'ws-1' });
    // Ответ создания парсится Zod-схемой витрины без переопределений.
    expect(uiCreatedTriggerSchema.safeParse(created).success).toBe(true);
  });

  it('список триггеров парсится UI-схемой (GET /triggers)', async () => {
    const { service } = harness();
    const list = await service.list('ws-1');

    expect(list).toHaveLength(1);
    expect(list.every((item) => uiTriggerSchema.safeParse(item).success)).toBe(
      true,
    );
    expect(list[0]).toMatchObject({
      status: 'active',
      promptTemplate: expect.stringContaining('{{payload}}'),
    });
  });

  it('constant-time проверка X-Trigger-Secret', () => {
    expect(secretMatches(SECRET, SECRET)).toBe(true);
    expect(secretMatches('wrong', SECRET)).toBe(false);
    expect(secretMatches(undefined, SECRET)).toBe(false);
    expect(secretMatches(`${SECRET}x`, SECRET)).toBe(false);
  });

  it('отклоняет неверный секрет до создания диалога', async () => {
    const { service, prisma, chat } = harness();

    await expect(
      service.receive('trigger-slug', 'wrong', { dealId: 1 }),
    ).rejects.toMatchObject({
      body: expect.objectContaining({ code: 'errors.invalid_trigger_secret' }),
    });
    expect(prisma.conversation.create).not.toHaveBeenCalled();
    expect(chat.handleMessage).not.toHaveBeenCalled();
  });

  it('запускает автономный диалог с подстановкой payload', async () => {
    const { service, chat, prisma } = harness();
    const result = await service.receive('trigger-slug', SECRET, {
      dealId: 42,
    });

    expect(result).toEqual({
      accepted: true,
      conversationId: 'conv-1',
      triggerId: 'trigger-1',
    });
    expect(chat.handleMessage).toHaveBeenCalledWith(
      'user-1',
      'conv-1',
      expect.stringContaining('"dealId":42'),
    );
    expect(chat.handleMessage).toHaveBeenCalledWith(
      'user-1',
      'conv-1',
      expect.stringContaining('bitrix24'),
    );
    expect(prisma.webhookTrigger.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ triggerCount: { increment: 1 } }),
      }),
    );
  });

  it('отклоняет payload больше 32 КБ', async () => {
    const { service, chat } = harness();
    const big = { data: 'x'.repeat(33 * 1024) };

    await expect(
      service.receive('trigger-slug', SECRET, big),
    ).rejects.toThrow(/32 КБ/);
    expect(chat.handleMessage).not.toHaveBeenCalled();
  });
});
