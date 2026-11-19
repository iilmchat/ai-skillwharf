import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import {
  createCustomAgentSchema,
  createWorkspaceAgent,
  customAgentRoleSchema,
  deleteWorkspaceAgent,
  fetchWorkspaceAgents,
  generateRoleKey,
  parseBudget,
  updateWorkspaceAgent,
} from './agent-builder';

const { getMock, postMock, patchMock, deleteMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  patchMock: vi.fn(),
  deleteMock: vi.fn(),
}));

vi.mock('./api', () => ({
  api: {
    get: getMock,
    post: postMock,
    patch: patchMock,
    delete: deleteMock,
  },
}));

vi.mock('../i18n', () => ({
  default: {
    t: (key: string) => `перевод:${key}`,
    exists: (key: string) => key.startsWith('errors.'),
  },
}));

const AGENT = {
  id: 'agent-1',
  workspaceId: 'ws-1',
  name: 'Менеджер продаж',
  roleKey: 'menedzher-prodazh',
  description: 'Работает с CRM',
  systemPrompt: 'Ты — менеджер продаж.',
  skillSlugs: ['skill-1'],
  hitlPolicy: 'high_risk',
  dailyBudgetRub: '5000.00',
  isActive: true,
  createdAt: '2026-11-19T10:00:00.000Z',
};

const FORM = {
  name: 'Менеджер продаж',
  systemPrompt: 'Ты — менеджер продаж.',
  skillSlugs: ['skill-1'],
  hitlPolicy: 'high_risk' as const,
  dailyBudgetRub: '5000',
};

describe('generateRoleKey', () => {
  it('транслитерирует кириллицу в kebab-case', () => {
    expect(generateRoleKey('Менеджер продаж')).toBe('menedzher-prodazh');
    expect(generateRoleKey('Контролёр документов')).toBe(
      'kontroler-dokumentov',
    );
  });

  it('оставляет латиницу и заменяет лишние символы', () => {
    expect(generateRoleKey('Sales Manager!')).toBe('sales-manager');
    expect(generateRoleKey('  Аналитик   Склада  ')).toBe(
      'analitik-sklada',
    );
  });

  it('возвращает пустую строку для строки без букв и цифр', () => {
    expect(generateRoleKey('!!!')).toBe('');
    expect(generateRoleKey('   ')).toBe('');
  });
});

describe('parseBudget', () => {
  it('принимает число, Decimal-строку, null и пустоту', () => {
    expect(parseBudget(100)).toBe(100);
    expect(parseBudget(' 99.90 ')).toBe(99.9);
    expect(parseBudget(null)).toBeNull();
    expect(parseBudget(undefined)).toBeNull();
    expect(parseBudget('')).toBeNull();
  });

  it('отклоняет отрицательные и нечисловые значения', () => {
    expect(parseBudget(-1)).toBeNull();
    expect(parseBudget('много')).toBeNull();
  });
});

describe('customAgentRoleSchema', () => {
  it('принимает ответ API и нормализует бюджет', () => {
    expect(customAgentRoleSchema.parse(AGENT)).toEqual({
      ...AGENT,
      dailyBudgetRub: 5000,
    });
  });

  it('поддерживает null-бюджет и описание', () => {
    expect(
      customAgentRoleSchema.parse({ ...AGENT, dailyBudgetRub: null, description: null }),
    ).toMatchObject({ dailyBudgetRub: null, description: null });
  });

  it('отклоняет неизвестную политику HITL и пустые поля', () => {
    expect(
      customAgentRoleSchema.safeParse({ ...AGENT, hitlPolicy: 'sometimes' })
        .success,
    ).toBe(false);
    expect(customAgentRoleSchema.safeParse({ ...AGENT, roleKey: '' }).success).toBe(
      false,
    );
  });
});

describe('createCustomAgentSchema', () => {
  it('генерирует roleKey из названия, если он не задан', () => {
    const parsed = createCustomAgentSchema.parse(FORM);

    expect(parsed.roleKey).toBe('menedzher-prodazh');
    expect(parsed.isActive).toBe(true);
    expect(parsed.dailyBudgetRub).toBe(5000);
  });

  it('оставляет введённый roleKey и строг (*) отклоняет лишние поля', () => {
    expect(
      createCustomAgentSchema.parse({ ...FORM, roleKey: 'my-agent' }).roleKey,
    ).toBe('my-agent');
    expect(
      createCustomAgentSchema.safeParse({ ...FORM, unexpected: true }).success,
    ).toBe(false);
  });

  it('отклоняет roleKey с кириллицей и пробелами', () => {
    expect(
      createCustomAgentSchema.safeParse({ ...FORM, roleKey: 'менеджер' }).success,
    ).toBe(false);
    expect(
      createCustomAgentSchema.safeParse({ ...FORM, roleKey: 'two words' }).success,
    ).toBe(false);
  });

  it('требует непустое название и системный промпт', () => {
    expect(createCustomAgentSchema.safeParse({ ...FORM, name: '' }).success).toBe(
      false,
    );
    expect(
      createCustomAgentSchema.safeParse({ ...FORM, systemPrompt: '' }).success,
    ).toBe(false);
  });
});

describe('agent builder API', () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
    patchMock.mockReset();
    deleteMock.mockReset();
  });

  it('читает агентов через GET /workspaces/:id/agents и валидирует ответ', async () => {
    getMock.mockResolvedValueOnce({ data: { items: [AGENT] } });

    await expect(fetchWorkspaceAgents('ws 1')).resolves.toEqual([
      { ...AGENT, dailyBudgetRub: 5000 },
    ]);
    expect(getMock).toHaveBeenCalledWith('/workspaces/ws%201/agents');
  });

  it('не пропускает невалидного агента в списке', async () => {
    getMock.mockResolvedValueOnce({ data: [{ ...AGENT, id: '' }] });

    await expect(fetchWorkspaceAgents('ws-1')).rejects.toBeInstanceOf(ZodError);
  });

  it('создаёт агента с автогенерированным roleKey', async () => {
    postMock.mockResolvedValueOnce({ data: { agent: AGENT } });

    await expect(createWorkspaceAgent('ws-1', FORM)).resolves.toEqual({
      ...AGENT,
      dailyBudgetRub: 5000,
    });
    expect(postMock).toHaveBeenCalledWith('/workspaces/ws-1/agents', {
      ...FORM,
      roleKey: 'menedzher-prodazh',
      isActive: true,
      dailyBudgetRub: 5000,
    });
  });

  it('проверяет форму до POST', async () => {
    await expect(
      createWorkspaceAgent('ws-1', { ...FORM, name: '' }),
    ).rejects.toBeInstanceOf(ZodError);
    expect(postMock).not.toHaveBeenCalled();
  });

  it('обновляет агента через PATCH и кодирует id', async () => {
    patchMock.mockResolvedValueOnce({ data: AGENT });

    await expect(
      updateWorkspaceAgent('ws-1', 'agent 1', { isActive: false }),
    ).resolves.toEqual({ ...AGENT, dailyBudgetRub: 5000 });
    expect(patchMock).toHaveBeenCalledWith(
      '/workspaces/ws-1/agents/agent%201',
      { isActive: false },
    );
  });

  it('удаляет агента через DELETE', async () => {
    await deleteWorkspaceAgent('ws-1', 'agent-1');

    expect(deleteMock).toHaveBeenCalledWith('/workspaces/ws-1/agents/agent-1');
  });
});
