import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';

import { db } from '@/server/db';
import { apiRateLimits } from '@/server/db/schema';
import { ApiFailure } from './respond';
import { consume, enforceRateLimit, principalKey } from './rate-limit';

const hasDb = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!hasDb)('api rate limit', () => {
  const keys: string[] = [];
  const freshKey = () => {
    const key = `test:${randomUUID()}`;
    keys.push(key);
    return key;
  };

  afterEach(async () => {
    for (const key of keys.splice(0)) {
      await db.delete(apiRateLimits).where(eq(apiRateLimits.principalKey, key));
    }
  });

  it('allows up to the limit, then refuses', async () => {
    const key = freshKey();
    const config = { limit: 3, windowSeconds: 60 };

    const outcomes = [];
    for (let i = 0; i < 5; i++) outcomes.push(await consume(key, 'write', config));

    expect(outcomes.map((o) => o.allowed)).toEqual([true, true, true, false, false]);
    expect(outcomes[2]?.remaining).toBe(0);
  });

  /*
   * The reason this is one statement and not read-then-write.
   *
   * Concurrent requests are the case a rate limit exists for. A limiter that
   * reads the count, decides, then writes lets a burst of N through the moment
   * they interleave — and they interleave precisely under the load that
   * triggers the limit.
   */
  it('counts concurrent requests exactly once each', async () => {
    const key = freshKey();
    const config = { limit: 4, windowSeconds: 60 };

    const results = await Promise.all(
      Array.from({ length: 10 }, () => consume(key, 'write', config)),
    );

    expect(results.filter((r) => r.allowed)).toHaveLength(4);

    const [row] = await db.select().from(apiRateLimits).where(eq(apiRateLimits.principalKey, key));
    expect(row?.hits).toBe(10);
  });

  it('keeps buckets independent, so a read storm cannot block a write', async () => {
    const key = freshKey();
    const config = { limit: 1, windowSeconds: 60 };

    expect((await consume(key, 'read', config)).allowed).toBe(true);
    expect((await consume(key, 'read', config)).allowed).toBe(false);
    // A different bucket for the same principal is untouched.
    expect((await consume(key, 'write', config)).allowed).toBe(true);
  });

  it('keeps principals independent', async () => {
    const a = freshKey();
    const b = freshKey();
    const config = { limit: 1, windowSeconds: 60 };

    expect((await consume(a, 'write', config)).allowed).toBe(true);
    expect((await consume(a, 'write', config)).allowed).toBe(false);
    expect((await consume(b, 'write', config)).allowed).toBe(true);
  });

  it('resets once the window has passed', async () => {
    const key = freshKey();
    const config = { limit: 1, windowSeconds: 60 };

    expect((await consume(key, 'write', config)).allowed).toBe(true);
    expect((await consume(key, 'write', config)).allowed).toBe(false);

    // Age the window rather than sleeping for a minute.
    await db
      .update(apiRateLimits)
      .set({ windowStartedAt: new Date(Date.now() - 120_000) })
      .where(eq(apiRateLimits.principalKey, key));

    const after = await consume(key, 'write', config);
    expect(after.allowed).toBe(true);
    expect(after.remaining).toBe(0);
  });

  it('raises a 429 carrying Retry-After', async () => {
    const key = freshKey();
    const config = { limit: 1, windowSeconds: 60 };

    await enforceRateLimit(key, 'write', config);

    await expect(enforceRateLimit(key, 'write', config)).rejects.toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
    });

    const error = await enforceRateLimit(key, 'write', config).catch((e: unknown) => e);
    expect((error as ApiFailure).headers?.['Retry-After']).toMatch(/^\d+$/);
  });

  /*
   * Acceptance criterion 12 reaches here too. This value is written to a table
   * that gets joined in operational queries; an email in it is personal data
   * sitting somewhere nobody remembers to look.
   */
  it('keys on the user id, never the email', () => {
    const key = principalKey({ userId: 'abc-123' });
    expect(key).toBe('user:abc-123');
    expect(principalKey(null)).toBe('anonymous');
  });
});
