import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';

/**
 * Распределённая блокировка опроса Outbox (HA-34.2).
 *
 * При 3+ репликах API только одна должна читать и отправлять задачи в тике.
 * Блокировка снимается Lua-скриптом только если значение всё ещё наше —
 * иначе реплика может удалить чужую блокировку после истечения TTL.
 */
export interface IOutboxLock {
  readonly ownerToken: string;
  acquire(): Promise<boolean>;
  release(): Promise<void>;
}

export const OUTBOX_LOCK_KEY = 'billing:outbox:lock';
export const OUTBOX_LOCK_TTL_MS = 10_000;

const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end
`;

/** Redis-реализация: SET key token NX PX ttl. */
export class RedisOutboxLock implements IOutboxLock {
  readonly ownerToken = randomUUID();

  constructor(
    private readonly redis: Redis,
    readonly key: string = OUTBOX_LOCK_KEY,
    readonly ttlMs: number = OUTBOX_LOCK_TTL_MS,
  ) {}

  async acquire(): Promise<boolean> {
    const result = await this.redis.set(
      this.key,
      this.ownerToken,
      'PX',
      this.ttlMs,
      'NX',
    );

    return result === 'OK';
  }

  async release(): Promise<void> {
    await this.redis.eval(RELEASE_SCRIPT, 1, this.key, this.ownerToken);
  }
}

/** Локальный режим/тесты без Redis: блокировка всегда доступна. */
export class NoopOutboxLock implements IOutboxLock {
  readonly ownerToken = 'local';

  async acquire(): Promise<boolean> {
    return true;
  }

  async release(): Promise<void> {
    return;
  }
}

/** Фабрика: при отсутствии REDIS_URL работает без распределённой блокировки. */
export function createOutboxLock(
  env: NodeJS.ProcessEnv = process.env,
): IOutboxLock {
  const url = (env.REDIS_URL ?? '').trim();

  if (url === '') {
    return new NoopOutboxLock();
  }

  const redis = new Redis(url, {
    lazyConnect: true,
    connectTimeout: 1_500,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  redis.on('error', () => undefined); // ошибки Redis не должны ронить тик

  return new RedisOutboxLock(redis);
}
