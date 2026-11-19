import { AxiosError, type AxiosResponse } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { useWorkspaceStore } from '../store/workspace.store';
import {
  addWorkspaceMember,
  createWorkspace,
  fetchWorkspaceMembers,
  fetchWorkspaces,
  parseHitlLimit,
  updateWorkspaceMember,
  workspaceErrorKey,
  workspaceMemberSchema,
  workspaceRoleSchema,
  workspaceSchema,
} from './workspaces';

const { getMock, postMock, patchMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
  patchMock: vi.fn(),
}));

vi.mock('./api', () => ({
  api: { get: getMock, post: postMock, patch: patchMock },
}));

const WORKSPACE = {
  id: 'ws-1',
  organizationId: 'org-1',
  name: 'Основная команда',
  slug: 'main',
  isDefault: true,
  role: 'owner',
  hitlApprovalLimitRub: '15000.00',
};

const MEMBER = {
  id: 'member-1',
  userId: 'user-1',
  email: 'owner@example.com',
  name: 'Иван',
  role: 'admin',
  hitlApprovalLimitRub: 15000,
};

function apiError(code: string): AxiosError {
  const response = {
    status: 409,
    statusText: '',
    headers: {},
    config: {},
    data: { statusCode: 409, error: 'Conflict', code, message: 'ошибка' },
  } as unknown as AxiosResponse;

  return new AxiosError('запрос отклонён', undefined, undefined, undefined, response);
}

describe('Zod-контракты воркспейсов', () => {
  it('принимает роль и лимит в трёх форматах', () => {
    expect(workspaceRoleSchema.parse('admin')).toBe('admin');
    expect(workspaceRoleSchema.safeParse('superuser').success).toBe(false);

    for (const limit of [15000, '15000.00', null, undefined]) {
      expect(
        workspaceSchema.safeParse({ ...WORKSPACE, hitlApprovalLimitRub: limit })
          .success,
      ).toBe(true);
    }
    expect(
      workspaceSchema.safeParse({
        ...WORKSPACE,
        hitlApprovalLimitRub: -1,
      }).success,
    ).toBe(false);
  });

  it('валидирует участника', () => {
    expect(workspaceMemberSchema.parse(MEMBER)).toEqual(MEMBER);
    expect(
      workspaceMemberSchema.safeParse({ ...MEMBER, role: 'root' }).success,
    ).toBe(false);
    expect(
      workspaceMemberSchema.safeParse({ ...MEMBER, userId: '' }).success,
    ).toBe(false);
  });

  it('парсит лимит HITL в число', () => {
    expect(parseHitlLimit('15000.50')).toBe(15000.5);
    expect(parseHitlLimit(100)).toBe(100);
    expect(parseHitlLimit(null)).toBeNull();
    expect(parseHitlLimit('не число')).toBeNull();
  });
});

describe('клиент воркспейсов', () => {
  beforeEach(() => {
    getMock.mockReset();
    postMock.mockReset();
    patchMock.mockReset();
  });

  it('загружает список и участников', async () => {
    getMock.mockResolvedValueOnce({ data: [WORKSPACE] });
    getMock.mockResolvedValueOnce({ data: { items: [MEMBER] } });

    await expect(fetchWorkspaces()).resolves.toEqual([WORKSPACE]);
    expect(getMock).toHaveBeenCalledWith('/workspaces');

    await expect(fetchWorkspaceMembers('ws 1')).resolves.toEqual([MEMBER]);
    expect(getMock).toHaveBeenLastCalledWith('/workspaces/ws%201/members');
  });

  it('создаёт воркспейс и добавляет участника', async () => {
    postMock.mockResolvedValueOnce({ data: WORKSPACE });
    postMock.mockResolvedValueOnce({ data: MEMBER });

    await createWorkspace({ name: 'Основная команда' });
    expect(postMock).toHaveBeenNthCalledWith(1, '/workspaces', {
      name: 'Основная команда',
    });

    await addWorkspaceMember('ws-1', {
      email: 'user@example.com',
      role: 'operator',
      hitlApprovalLimitRub: 5000,
    });
    expect(postMock).toHaveBeenNthCalledWith(
      2,
      '/workspaces/ws-1/members',
      { email: 'user@example.com', role: 'operator', hitlApprovalLimitRub: 5000 },
    );
  });

  it('обновляет роль и лимит участника', async () => {
    patchMock.mockResolvedValueOnce({ data: MEMBER });

    await updateWorkspaceMember('ws-1', 'member-1', {
      role: 'viewer',
      hitlApprovalLimitRub: null,
    });

    expect(patchMock).toHaveBeenCalledWith(
      '/workspaces/ws-1/members/member-1',
      { role: 'viewer', hitlApprovalLimitRub: null },
    );
  });

  it('отвергает невалидный ответ API', async () => {
    getMock.mockResolvedValueOnce({ data: [{ id: 'ws' }] });

    await expect(fetchWorkspaces()).rejects.toBeInstanceOf(ZodError);
  });

  it('запрещает назначать owner через форму приглашения', async () => {
    await expect(
      addWorkspaceMember('ws-1', {
        email: 'user@example.com',
        role: 'owner' as 'viewer',
      }),
    ).rejects.toBeInstanceOf(ZodError);
    expect(postMock).not.toHaveBeenCalled();
  });

  it('возвращает i18n-ключи для ошибок ролей и лимита', () => {
    expect(
      workspaceErrorKey(apiError('errors.insufficient_workspace_role'), 'fallback'),
    ).toBe('errors.insufficient_workspace_role');
    expect(
      workspaceErrorKey(apiError('errors.hitl_limit_exceeded'), 'fallback'),
    ).toBe('errors.hitl_limit_exceeded');
    expect(workspaceErrorKey(apiError('errors.unknown'), 'fallback')).toBe(
      'fallback',
    );
  });
});

describe('store активного воркспейса', () => {
  it('сохраняет и сбрасывает выбранный workspaceId', () => {
    useWorkspaceStore.getState().setActiveWorkspace('ws-42');

    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe('ws-42');

    useWorkspaceStore.getState().reset();
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBeNull();
  });
});
