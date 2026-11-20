import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';

/** Распределённая блокировка тикера планировщика (CRON-43.1, HA). */
export interface ISchedulerLock {
  readonly ownerToken: string;
  acquire(): Promise<boolean>;
  release(): Promise<void>;
}

export const SCHEDULER_LOCK_KEY = 'scheduler:jobs:lock';
export const SCHEDULER_LOCK_TTL_MS = 15_000;

const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end
`;

export class RedisSchedulerLock implements ISchedulerLock {
  readonly ownerToken = randomUUID();

  constructor(
    private readonly redis: Redis,
    readonly key: string = SCHEDULER_LOCK_KEY,
    readonly ttlMs: number = SCHEDULER_LOCK_TTL_MS,
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

/** Локальный режим/тесты без Redis. */
export class NoopSchedulerLock implements ISchedulerLock {
  readonly ownerToken = 'local';

  async acquire(): Promise<boolean> {
    return true;
  }

  async release(): Promise<void> {
    return;
  }
}

/** При отсутствии REDIS_URL работает без распределённой блокировки. */
export function createSchedulerLock(
  env: NodeJS.ProcessEnv = process.env,
): ISchedulerLock {
  const url = (env.REDIS_URL ?? '').trim();

  if (url === '') {
    return new NoopSchedulerLock();
  }

  const redis = new Redis(url, {
    lazyConnect: true,
    connectTimeout: 1_500,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  });
  redis.on('error', () => undefined);

  return new RedisSchedulerLock(redis);
}
