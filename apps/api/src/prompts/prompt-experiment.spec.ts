import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { PromptExperiment, PromptVersion } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { AuditService } from '../audit/audit.service.js';
import { PromptsService, selectExperimentVariant } from './prompts.service.js';

const TEMPLATE_ID = 'prompt-1';
const USER = 'user-1';

function row(overrides: Partial<PromptExperiment> = {}): PromptExperiment {
  return {
    id: 'exp-1',
    promptId: TEMPLATE_ID,
    name: 'Новый промпт против старого',
    variantAVersionId: 'v1',
    variantBVersionId: 'v2',
    trafficSplitB: 50,
    status: 'running',
    winnerVersionId: null,
    metricsJson: {
      A: { requests: 0, totalLatencyMs: 0, totalCost: 0 },
      B: { requests: 0, totalLatencyMs: 0, totalCost: 0 },
    },
    createdAt: new Date('2026-11-19T00:00:00Z'),
    stoppedAt: null,
    ...overrides,
  };
}

function harness(experiment: PromptExperiment | null) {
  const experiments = experiment === null ? [] : [experiment];
  const prisma = {
    promptTemplate: {
      findFirst: vi.fn(async () => ({
        id: TEMPLATE_ID,
        name: 'default',
        isActive: true,
        versions: [{ id: 'v3', version: 3, content: 'Текущий промпт' }],
      })),
      findUnique: vi.fn(async () => ({ id: TEMPLATE_ID, name: 'default' })),
    },
    promptExperiment: {
      findFirst: vi.fn(async () => experiments[0] ?? null),
      findMany: vi.fn(async () => experiments),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        experiments.find((item) => item.id === where.id) ?? null,
      ),
      create: vi.fn(async (args: { data: Partial<PromptExperiment> }) => {
        const created = row(args.data as Partial<PromptExperiment>);

        experiments.push(created);

        return created;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Partial<PromptExperiment> }) => {
          const existing = experiments.find((item) => item.id === where.id);

          if (existing === undefined) {
            throw new Error('not found');
          }

          const updated = { ...existing, ...data };
          experiments[experiments.indexOf(existing)] = updated;

          return updated;
        },
      ),
    },
    promptVersion: {
      findMany: vi.fn(async () => [{ id: 'v1', templateId: TEMPLATE_ID }, { id: 'v2', templateId: TEMPLATE_ID }]),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          ({
            id: where.id,
            templateId: TEMPLATE_ID,
            content: `Контент ${where.id}`,
          }) as PromptVersion,
      ),
    },
  };
  const audit = { record: vi.fn(async () => undefined) };
  const service = new PromptsService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
  );

  return { service, prisma, audit, experiments };
}

describe('A/B-эксперименты промптов (WEB-28.1 / KI-009)', () => {
  it('детерминированно делит трафик по хешу conversationId', () => {
    const counts = { A: 0, B: 0 };

    for (let index = 0; index < 1_000; index += 1) {
      counts[selectExperimentVariant(`conversation-${index}`, 35)] += 1;
    }

    expect(counts.A + counts.B).toBe(1_000);
    expect(counts.B).toBeGreaterThan(250);
    expect(counts.B).toBeLessThan(420);
    // Повтор того же диалога даёт тот же вариант.
    expect(selectExperimentVariant('conversation-42', 35)).toBe(
      selectExperimentVariant('conversation-42', 35),
    );
    expect(selectExperimentVariant('x', 0)).toBe('A');
    expect(selectExperimentVariant('x', 100)).toBe('B');
  });

  it('выбирает вариант промпта и считает запросы по вариантам', async () => {
    const { service, experiments } = harness(row({ trafficSplitB: 100 }));
    const resolved = await service.resolveSystemPrompt('default', 'dialog-1');

    expect(resolved.versionId).toBe('v2');
    expect(resolved.content).toBe('Контент v2');
    expect(resolved.experimentId).toBe('exp-1');
    expect(resolved.variant).toBe('B');
    expect(experiments[0]?.metricsJson).toMatchObject({
      B: { requests: 1 },
    });

    // Без conversationId — обычная активная версия, метрики не меняются.
    const plain = await service.resolveSystemPrompt('default');

    expect(plain.content).toBe('Текущий промпт');
    expect(plain.experimentId).toBeNull();
  });

  it('фиксирует latency/cost и отдаёт средние значения в списке', async () => {
    const { service } = harness(row());

    await service.recordExperimentUsage('exp-1', 'A', 100, 0.5);
    await service.recordExperimentUsage('exp-1', 'A', 300, 1.1);
    await service.recordExperimentUsage('exp-1', 'B', 200, 0.9);

    const [view] = await service.listExperiments(TEMPLATE_ID);

    expect(view?.metrics.A).toEqual({
      requests: 2,
      avgLatencyMs: 200,
      avgCost: 0.8,
    });
    expect(view?.metrics.B).toEqual({
      requests: 1,
      avgLatencyMs: 200,
      avgCost: 0.9,
    });
  });

  it('запрещает два running-эксперимента на один промпт', async () => {
    const { service } = harness(row());

    await expect(
      service.startExperiment(
        TEMPLATE_ID,
        {
          name: 'Второй',
          variantAVersionId: 'v1',
          variantBVersionId: 'v2',
          trafficSplitB: 20,
        },
        USER,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('останавливает эксперимент и промоутит победителя', async () => {
    const { service, audit } = harness(row());
    const stopped = await service.stopExperiment(
      'exp-1',
      { promoteVersionId: 'v2' },
      USER,
    );

    expect(stopped.status).toBe('completed');
    expect(stopped.winnerVersionId).toBe('v2');
    expect(stopped.stoppedAt).not.toBeNull();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'prompt.experiment.stop' }),
    );
  });

  it('отвергает невалидный trafficSplitB через Zod', async () => {
    const { service } = harness(null);

    await expect(
      service.startExperiment(
        TEMPLATE_ID,
        {
          name: 'Плохой',
          variantAVersionId: 'v1',
          variantBVersionId: 'v1',
          trafficSplitB: 101,
        },
        USER,
      ),
    ).rejects.toThrow();
  });
});
