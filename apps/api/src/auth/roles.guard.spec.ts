import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { RolesGuard } from './guards/roles.guard.js';

const handler = () => undefined;
class TestController {}

interface RequestWithUser {
  user?: { userId: string; email: string; role: string };
}

function createContext(user?: RequestWithUser['user']): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => TestController,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  let reflector: { getAllAndOverride: ReturnType<typeof vi.fn> };
  let guard: RolesGuard;

  beforeEach(() => {
    reflector = { getAllAndOverride: vi.fn() };
    guard = new RolesGuard(reflector as unknown as Reflector);
  });

  const user = { userId: 'user-1', email: 'user@example.com', role: 'user' };

  it('пропускает эндпоинт без ограничений по ролям', () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);

    expect(guard.canActivate(createContext(user))).toBe(true);
  });

  it('пропускает эндпоинт с пустым списком ролей', () => {
    reflector.getAllAndOverride.mockReturnValue([]);

    expect(guard.canActivate(createContext(user))).toBe(true);
  });

  it('пропускает пользователя с подходящей ролью', () => {
    reflector.getAllAndOverride.mockReturnValue(['admin', 'user']);

    expect(guard.canActivate(createContext(user))).toBe(true);
  });

  it('запрещает доступ пользователю с другой ролью', () => {
    reflector.getAllAndOverride.mockReturnValue(['admin']);

    expect(() => guard.canActivate(createContext(user))).toThrow(
      ForbiddenException,
    );
  });

  it('запрещает доступ, если пользователь не аутентифицирован', () => {
    reflector.getAllAndOverride.mockReturnValue(['admin']);

    expect(() => guard.canActivate(createContext())).toThrow(
      ForbiddenException,
    );
  });
});
