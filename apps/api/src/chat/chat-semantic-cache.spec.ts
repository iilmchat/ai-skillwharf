import { describe, expect, it, vi } from 'vitest';
import type { SemanticCacheService } from '../llm/semantic-cache.service.js';
import { ChatService } from './chat.service.js';

/**
 * Проверяет главное свойство семантического кеша: при cacheHit:true не
 * вызывается worker и, значит, не резервируются/не списываются токены в Ledger.
 */
function harness(cacheHit: boolean) {
  const prisma = {
    conversation: {
      findUnique: vi.fn(async () => ({ id: 'c1', userId: 'u1' })),
      update: vi.fn(async () => ({})),
    },
    message: {
      create: vi.fn(async () => ({})),
      findMany: vi.fn(async () => [{ role: 'user', content: 'привет' }]),
    },
    user: { findUnique: vi.fn(async () => ({ role: 'user' })) },
  };
  const worker = {
    run: vi.fn(async function* () {
      yield { type: 'done', conversationId: 'c1', reply: 'Свежий ответ', pendingApproval: false };
    }),
    resume: vi.fn(),
  };
  const billing = {
    getBalance: vi.fn(async () => ({ balance: '10.00' })),
    chargeForSkill: vi.fn(async () => ({ balance: '9.99', entryId: 'e1' })),
    chargeForMarketplaceSkill: vi.fn(),
    cancelHold: vi.fn(),
  };
  const skills = {
    getEnabledSkills: vi.fn(async () => []),
  };
  const router = { selectRoutes: vi.fn(async () => []) };
  const memory = {
    buildContext: vi.fn(async () => ''),
    remember: vi.fn(async () => 1),
  };
  const prompts = {
    getActiveSystemPrompt: vi.fn(async () => 'Базовый промпт'),
  };
  const checkpoints = { deleteThread: vi.fn(async () => undefined) };
  const pending = {
    findPending: vi.fn(async () => null),
    listPending: vi.fn(async () => []),
    resolvePending: vi.fn(async () => 1),
  };
  const tools = { buildDescriptors: vi.fn(() => []) };
  const semanticCache = {
    lookup: vi.fn(async () =>
      cacheHit
        ? { hit: true as const, reply: 'Кешированный ответ', score: 0.98 }
        : { hit: false as const },
    ),
    store: vi.fn(async () => undefined),
  };

  const service = new ChatService(
    prisma as never,
    worker as never,
    billing as never,
    skills as never,
    router as never,
    memory as never,
    prompts as never,
    checkpoints as never,
    pending as never,
    tools as never,
    semanticCache as unknown as SemanticCacheService,
  );

  return { service, worker, billing, semanticCache, prisma };
}

describe('ChatService + семантический кеш (CACHE-30.2)', () => {
  it('на попадании возвращает cacheHit:true и не вызывает LLM/Ledger', async () => {
    const { service, worker, billing, semanticCache } = harness(true);

    const reply = await service.handleMessage('u1', 'c1', 'Тот же вопрос');

    expect(reply).toMatchObject({
      conversationId: 'c1',
      reply: 'Кешированный ответ',
      cacheHit: true,
    });
    expect(worker.run).not.toHaveBeenCalled();
    expect(billing.chargeForSkill).not.toHaveBeenCalled();
    expect(billing.chargeForMarketplaceSkill).not.toHaveBeenCalled();
    expect(semanticCache.store).not.toHaveBeenCalled();
  });

  it('при промахе вызывает worker и сохраняет ответ в кеш', async () => {
    const { service, worker, semanticCache } = harness(false);

    const reply = await service.handleMessage('u1', 'c1', 'Новый вопрос');

    expect(reply.reply).toBe('Свежий ответ');
    expect(reply.cacheHit).toBeUndefined();
    expect(worker.run).toHaveBeenCalledTimes(1);
    expect(semanticCache.store).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', query: 'Новый вопрос' }),
      'Свежий ответ',
    );
  });

  it('ключ кеша содержит userId и версию промпта', async () => {
    const { service, semanticCache } = harness(false);

    await service.handleMessage('u1', 'c1', 'Вопрос');

    const key = (semanticCache.lookup.mock.calls[0] as [Record<string, unknown>])[0];

    expect(key).toMatchObject({
      userId: 'u1',
      model: 'unknown',
      toolsEnabled: false,
    });
    expect(typeof key.promptVersionId).toBe('string');
    expect(key.promptVersionId).not.toBe('');
  });
});
