import { describe, expect, it } from 'vitest';
import {
  NoopSchedulerLock,
  RedisSchedulerLock,
  SCHEDULER_LOCK_KEY,
  SCHEDULER_LOCK_TTL_MS,
  type ISchedulerLock,
} from './scheduler-lock.js';

/** Общий mock Redis для симуляции трёх реплик API. */
class SharedRedis {
  private values = new Map<string, string>();

  async set(
    key: string,
    value: string,
    mode: string,
    ttl: number,
    nx: string,
  ): Promise<string | null> {
    expect(mode).toBe('PX');
    expect(ttl).toBe(SCHEDULER_LOCK_TTL_MS);
    expect(nx).toBe('NX');
    if (this.values.has(key)) {
      return null;
    }
    this.values.set(key, value);

    return 'OK';
  }

  async eval(
    script: string,
    keyCount: number,
    key: string,
    token: string,
  ): Promise<number> {
    expect(script).toContain("redis.call('get', KEYS[1]) == ARGV[1]");
    expect(keyCount).toBe(1);
    if (this.values.get(key) === token) {
      this.values.delete(key);

      return 1;
    }

    return 0;
  }
}

describe('RedisSchedulerLock (CRON-43.1, HA)', () => {
  it('три реплики: тик выполняет ровно одна', async () => {
    const redis = new SharedRedis();
    const locks: ISchedulerLock[] = Array.from(
      { length: 3 },
      () => new RedisSchedulerLock(redis as never),
    );
    let ticks = 0;

    await Promise.all(
      locks.map(async (lock) => {
        if (await lock.acquire()) {
          try {
            ticks += 1;
          } finally {
            await lock.release();
          }
        }
      }),
    );

    expect(ticks).toBe(1);
    expect(redis).toBeDefined();
    expect(SCHEDULER_LOCK_KEY).toBe('scheduler:jobs:lock');
  });

  it('Noop-lock всегда доступен (без Redis)', async () => {
    const lock = new NoopSchedulerLock();

    await expect(lock.acquire()).resolves.toBe(true);
    await expect(lock.release()).resolves.toBeUndefined();
  });
});
