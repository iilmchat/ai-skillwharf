import { describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../audit/audit.service.js';
import { ApiException } from '../common/api-error.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { PromptEvalsService } from './prompt-evals.service.js';
import { PromptsService } from './prompts.service.js';

const EXP_ID = 'exp-1';
const PROMPT_ID = 'prompt-1';
const VERSION_ID = 'version-2';

function harness(gatePromotion: boolean, hasPassingEval: boolean) {
  const experiment = {
    id: EXP_ID,
    promptId: PROMPT_ID,
    name: 'Тестовый эксперимент',
    variantAVersionId: 'version-1',
    variantBVersionId: VERSION_ID,
    trafficSplitB: 50,
    status: 'running',
    winnerVersionId: null,
    metricsJson: null,
    createdAt: new Date('2026-11-19T10:00:00Z'),
    stoppedAt: null,
  };
  const prisma = {
    promptExperiment: {
      findUnique: vi.fn(async () => experiment),
      update: vi.fn(async (args: { data: Record<string, unknown> }) => ({
        ...experiment,
        ...args.data,
      })),
    },
    promptVersion: {
      findUnique: vi.fn(async () => ({ templateId: PROMPT_ID })),
    },
  };
  const evals = {
    gatePromotion,
    hasPassingEval: vi.fn(async () => hasPassingEval),
  } as unknown as PromptEvalsService;
  const audit = { record: vi.fn(async () => undefined) };
  const service = new PromptsService(
    prisma as unknown as PrismaService,
    audit as unknown as AuditService,
    evals,
  );

  return { service, prisma, evals, audit };
}

describe('Evals-гейт промоушена A/B (EVAL-29.3)', () => {
  it('блокирует промоушен при EVALS_GATE_PROMOTION=true без зелёного прогона', async () => {
    const { service, prisma, evals } = harness(true, false);

    await expect(
      service.stopExperiment(
        EXP_ID,
        { promoteVersionId: VERSION_ID },
        'user-1',
      ),
    ).rejects.toMatchObject({
      body: expect.objectContaining({ code: 'errors.eval_gate_failed' }),
    });
    expect(evals.hasPassingEval).toHaveBeenCalledWith(VERSION_ID);
    expect(prisma.promptExperiment.update).not.toHaveBeenCalled();
  });

  it('блокирует промоушен при явном requirePassingEval даже без политики env', async () => {
    const { service, prisma } = harness(false, false);

    await expect(
      service.stopExperiment(
        EXP_ID,
        { promoteVersionId: VERSION_ID, requirePassingEval: true },
        'user-1',
      ),
    ).rejects.toBeInstanceOf(ApiException);
    expect(prisma.promptExperiment.update).not.toHaveBeenCalled();
  });

  it('промоутит версию после зелёного Eval-прогона', async () => {
    const { service, prisma, audit } = harness(true, true);
    const result = await service.stopExperiment(
      EXP_ID,
      { promoteVersionId: VERSION_ID },
      'user-1',
    );

    expect(result.status).toBe('completed');
    expect(result.winnerVersionId).toBe(VERSION_ID);
    expect(prisma.promptExperiment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'completed',
          winnerVersionId: VERSION_ID,
        }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'prompt.experiment.stop' }),
    );
  });

  it('остановка без промоушена не требует Evals', async () => {
    const { service, evals, prisma } = harness(true, false);
    const result = await service.stopExperiment(EXP_ID, {}, 'user-1');

    expect(result.status).toBe('stopped');
    expect(result.winnerVersionId).toBeNull();
    expect(evals.hasPassingEval).not.toHaveBeenCalled();
    expect(prisma.promptExperiment.update).toHaveBeenCalled();
  });
});
