import type { ExecutionContext } from '@nestjs/common';
import { InternalTokenAuth, issueInternalJwt } from '@skillwharf/shared';
import { describe, expect, it } from 'vitest';
import { ApiException } from '../common/api-error.js';
import { InternalTokenGuard } from './internal-token.guard.js';

const SECRET = 's'.repeat(32);

function context(token: string | undefined): ExecutionContext {
  const request = { header: () => token };

  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function guard(env: NodeJS.ProcessEnv): InternalTokenGuard {
  return new InternalTokenGuard(new InternalTokenAuth(env));
}

const env = { NODE_ENV: 'test', INTERNAL_API_TOKEN: SECRET };

describe('InternalTokenGuard', () => {
  it('пропускает JWT worker → API с правильной аудиторией', () => {
    const token = issueInternalJwt(SECRET, { direction: 'worker-to-api' });

    expect(guard(env).canActivate(context(token))).toBe(true);
  });

  it('отвергает JWT с чужой аудиторией единым JSON-исключением', () => {
    const token = issueInternalJwt(SECRET, { direction: 'api-to-worker' });

    expect(() => guard(env).canActivate(context(token))).toThrow(ApiException);
  });

  it('отвергает статический токен без явного legacy-флага', () => {
    expect(() => guard(env).canActivate(context(SECRET))).toThrow(ApiException);
    const legacyGuard = guard({
      ...env,
      ALLOW_LEGACY_INTERNAL_TOKEN: 'true',
    });

    expect(legacyGuard.canActivate(context(SECRET))).toBe(true);
  });

  it('fail closed в production с коротким секретом', () => {
    expect(() =>
      guard({ NODE_ENV: 'production', INTERNAL_API_TOKEN: 'short' }),
    ).toThrow(/INTERNAL_API_TOKEN/);
  });
});
