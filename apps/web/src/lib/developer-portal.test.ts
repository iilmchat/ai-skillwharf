import { AxiosError, type AxiosResponse } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import {
  auditFindingSchema,
  developerDashboardSchema,
  developerSkillItemSchema,
  DeveloperPortalError,
  fetchDeveloperDashboard,
  getDeveloperPortalErrorMessage,
  isSkillAuditRejected,
  parseAuditFindings,
  publishDeveloperSkill,
  publishDeveloperSkillSchema,
  updateSkillPayoutAccount,
} from './developer-portal';

const { getMock, postMock, patchMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  patchMock: vi.fn(),
}));

vi.mock('./api', () => ({
  api: { get: getMock, post: postMock, patch: patchMock },
}));

vi.mock('../i18n', () => ({
  default: {
    t: (key: string) => `перевод:${key}`,
    exists: (key: string) => key.startsWith('errors.'),
  },
}));

function axiosErrorWith(data: unknown, status: number): AxiosError {
  const response = {
    data,
    status,
    statusText: 'Error',
    headers: {},
    config: {},
  } as unknown as AxiosResponse;

  return new AxiosError(
    'Request failed',
    undefined,
    undefined,
    undefined,
    response,
  );
}

const FINDINGS = [
  {
    severity: 'critical',
    code: 'seccomp_missing',
    message: 'Манифест не задаёт seccomp-политику',
  },
  {
    severity: 'warning',
    code: 'egress_wide',
    message: 'Разрешён широкий egress',
  },
];

const SKILL = {
  id: 'skill-1',
  slug: 'sales-analyst',
  name: 'Sales Analyst',
  version: '1.2.0',
  pricingModel: 'Pay-per-Call',
  price: '15.00',
  downloadsCount: 42,
  verified: true,
  auditStatus: 'passed',
  auditFindings: [],
  payoutAccountId: null,
  createdAt: '2026-11-19T10:00:00.000Z',
};

const DASHBOARD = {
  totalSkills: 1,
  totalDownloads: 42,
  totalRevenueRub: '357.00',
  pendingPayoutRub: '53.55',
  skills: [SKILL],
};

describe('auditFindingSchema', () => {
  it('принимает три уровня серьёзности и отклоняет неизвестный', () => {
    expect(auditFindingSchema.parse(FINDINGS[0])).toEqual(FINDINGS[0]);
    expect(auditFindingSchema.parse(FINDINGS[1])).toEqual(FINDINGS[1]);
    expect(
      auditFindingSchema.safeParse({ ...FINDINGS[0], severity: 'fatal' })
        .success,
    ).toBe(false);
  });

  it('требует code и message', () => {
    expect(auditFindingSchema.safeParse({ severity: 'info' }).success).toBe(
      false,
    );
  });
});

describe('developerSkillItemSchema', () => {
  it('приводит Decimal-цену к числу и сохраняет секретные поля', () => {
    expect(developerSkillItemSchema.parse(SKILL)).toEqual({
      ...SKILL,
      price: 15,
    });
  });

  it('поддерживает число, опциональные findings и payout', () => {
    expect(
      developerSkillItemSchema.parse({
        ...SKILL,
        price: 20.5,
        auditStatus: 'warning',
        auditFindings: FINDINGS,
        payoutAccountId: 'yoo-1',
      }),
    ).toMatchObject({ price: 20.5, payoutAccountId: 'yoo-1' });
  });

  it('отклоняет неизвестный статус аудита и отрицательную цену', () => {
    expect(
      developerSkillItemSchema.safeParse({ ...SKILL, auditStatus: 'unknown' })
        .success,
    ).toBe(false);
    expect(
      developerSkillItemSchema.safeParse({ ...SKILL, price: '-1' }).success,
    ).toBe(false);
  });
});

describe('developerDashboardSchema', () => {
  it('приводит денежные строки к числам и разбирает вложенный ответ', () => {
    expect(developerDashboardSchema.parse(DASHBOARD)).toEqual({
      totalSkills: 1,
      totalDownloads: 42,
      totalRevenueRub: 357,
      pendingPayoutRub: 53.55,
      skills: [{ ...SKILL, price: 15 }],
    });
  });

  it('клиент принимает обёртку { dashboard }', async () => {
    getMock.mockResolvedValueOnce({ data: { dashboard: DASHBOARD } });

    await expect(fetchDeveloperDashboard()).resolves.toMatchObject({
      totalRevenueRub: 357,
    });
  });

  it('отклоняет нечисловую выручку', () => {
    expect(
      developerDashboardSchema.safeParse({
        ...DASHBOARD,
        totalRevenueRub: 'много',
      }).success,
    ).toBe(false);
  });
});

describe('publishDeveloperSkillSchema', () => {
  it('требует манифест и строг (*) не принимает лишние поля', () => {
    expect(
      publishDeveloperSkillSchema.parse({
        manifestYaml: '---\nname: x\n---',
        payoutAccountId: 'yoo-1',
      }),
    ).toEqual({ manifestYaml: '---\nname: x\n---', payoutAccountId: 'yoo-1' });
    expect(publishDeveloperSkillSchema.safeParse({ manifestYaml: '' }).success).toBe(
      false,
    );
    expect(
      publishDeveloperSkillSchema.safeParse({ manifestYaml: 'x', extra: 1 })
        .success,
    ).toBe(false);
  });
});

describe('audit rejection helpers', () => {
  it('распознаёт код отказа аудита и достаёт findings из разных полей', () => {
    const body = {
      code: 'errors.skill_audit_rejected',
      message: 'Audit failed',
      findings: FINDINGS,
    };

    expect(isSkillAuditRejected(body)).toBe(true);
    expect(parseAuditFindings(body)).toEqual(FINDINGS);
    expect(isSkillAuditRejected({ code: 'errors.invalid_request' })).toBe(false);
    expect(parseAuditFindings({ details: { findings: FINDINGS } })).toEqual(
      FINDINGS,
    );
    expect(parseAuditFindings({ details: FINDINGS })).toEqual(FINDINGS);
  });

  it('поднимает DeveloperPortalError с замечаниями на 400', async () => {
    postMock.mockRejectedValueOnce(
      axiosErrorWith(
        {
          code: 'errors.skill_audit_rejected',
          findings: FINDINGS,
        },
        400,
      ),
    );

    await expect(
      publishDeveloperSkill({ manifestYaml: '---\nname: x\n---' }),
    ).rejects.toMatchObject({
      code: 'auditRejected',
      findings: FINDINGS,
    });
  });

  it('маппит 404 в unavailable и даёт локализованное сообщение', () => {
    const error = axiosErrorWith({ message: 'Not found' }, 404);

    expect(getDeveloperPortalErrorMessage(error)).toBe(
      'перевод:developerPortal.errors.unavailable',
    );
    expect(
      getDeveloperPortalErrorMessage(
        axiosErrorWith({ code: 'errors.skill_audit_rejected' }, 400),
      ),
    ).toBe('перевод:errors.skill_audit_rejected');
    expect(getDeveloperPortalErrorMessage(new ZodError([]))).toBe(
      'перевод:developerPortal.errors.invalidResponse',
    );
    expect(
      getDeveloperPortalErrorMessage(new DeveloperPortalError('forbidden')),
    ).toBe('перевод:developerPortal.errors.forbidden');
  });
});

describe('developer portal API', () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
    patchMock.mockReset();
  });

  it('читает дашборд через GET /developer/skills', async () => {
    getMock.mockResolvedValueOnce({ data: DASHBOARD });

    await expect(fetchDeveloperDashboard()).resolves.toEqual({
      totalSkills: 1,
      totalDownloads: 42,
      totalRevenueRub: 357,
      pendingPayoutRub: 53.55,
      skills: [{ ...SKILL, price: 15 }],
    });
    expect(getMock).toHaveBeenCalledWith('/developer/skills');
  });

  it('не пропускает невалидный дашборд', async () => {
    getMock.mockResolvedValueOnce({ data: { ...DASHBOARD, skills: 'нет' } });

    await expect(fetchDeveloperDashboard()).rejects.toBeInstanceOf(ZodError);
  });

  it('публикует навык через POST /developer/skills', async () => {
    postMock.mockResolvedValueOnce({ data: { skill: SKILL } });

    await expect(
      publishDeveloperSkill({ manifestYaml: '---\nname: x\n---' }),
    ).resolves.toEqual({ ...SKILL, price: 15 });
    expect(postMock).toHaveBeenCalledWith('/developer/skills', {
      manifestYaml: '---\nname: x\n---',
    });
  });

  it('проверяет форму до запроса', async () => {
    await expect(publishDeveloperSkill({ manifestYaml: '' })).rejects.toBeInstanceOf(
      ZodError,
    );
    expect(postMock).not.toHaveBeenCalled();
  });

  it('обновляет счёт выплат через PATCH .../payout и проверяет slug', async () => {
    patchMock.mockResolvedValueOnce({
      data: { ...SKILL, payoutAccountId: 'yoo-1' },
    });

    await expect(
      updateSkillPayoutAccount('sales-analyst', 'yoo-1'),
    ).resolves.toMatchObject({ payoutAccountId: 'yoo-1' });
    expect(patchMock).toHaveBeenCalledWith(
      '/developer/skills/sales-analyst/payout',
      { payoutAccountId: 'yoo-1' },
    );
  });

  it('отклоняет невалидный slug до запроса', async () => {
    await expect(
      updateSkillPayoutAccount('Sales Analyst!', 'yoo-1'),
    ).rejects.toBeInstanceOf(ZodError);
    expect(patchMock).not.toHaveBeenCalled();
  });
});
