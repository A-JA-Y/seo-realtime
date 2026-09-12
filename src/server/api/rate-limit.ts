import { and, sql } from 'drizzle-orm';

import { ApiFailure } from './respond';
import { db } from '@/server/db';
import { apiRateLimits } from '@/server/db/schema';

/**
 * Per-principal rate limiting for the API (§10).
 *
 * Backed by a table rather than by memory. Serverless functions are many and
 * short-lived: an in-memory counter is per-instance, so the effective limit is
 * the configured one multiplied by however many instances happen to be warm —
 * which is not a limit, it is a suggestion that gets weaker under load, which
 * is exactly when it matters.
 *
 * The "check now" cooldown is deliberately NOT this. That one is claimed with a
 * conditional UPDATE on the target row because it guards SPENDING and must be
 * exactly once per five minutes per target; this guards effort, and a fixed
 * window is the right shape for it.
 */

export interface RateLimit {
  /** Requests allowed per window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
}

/**
 * Fixed window, incremented atomically.
 *
 * One statement: the upsert both resets an expired window and increments a live
 * one, so two concurrent requests cannot both read "0 so far" and both proceed.
 * A read-then-write would let a burst through precisely when a burst is the
 * thing being limited.
 *
 * Fails OPEN on a database error. A rate limiter that takes the API down with
 * it has turned a throttle into an outage; the request is served and the error
 * surfaces through the caller's own logging.
 */
export async function consume(
  key: string,
  bucket: string,
  { limit, windowSeconds }: RateLimit,
): Promise<{ allowed: boolean; remaining: number; resetSeconds: number }> {
  try {
    const result = await db.execute<{ hits: number; reset_seconds: number }>(sql`
      INSERT INTO api_rate_limits (principal_key, bucket, window_started_at, hits)
      VALUES (${key}, ${bucket}, now(), 1)
      ON CONFLICT (principal_key, bucket) DO UPDATE SET
        window_started_at = CASE
          WHEN api_rate_limits.window_started_at < now() - (${windowSeconds} * interval '1 second')
          THEN now() ELSE api_rate_limits.window_started_at END,
        hits = CASE
          WHEN api_rate_limits.window_started_at < now() - (${windowSeconds} * interval '1 second')
          THEN 1 ELSE api_rate_limits.hits + 1 END
      RETURNING
        hits,
        CEIL(EXTRACT(EPOCH FROM (
          window_started_at + (${windowSeconds} * interval '1 second') - now()
        )))::int AS reset_seconds
    `);

    const row = result.rows[0];
    if (!row) return { allowed: true, remaining: limit, resetSeconds: windowSeconds };

    return {
      allowed: row.hits <= limit,
      remaining: Math.max(0, limit - row.hits),
      resetSeconds: Math.max(1, row.reset_seconds),
    };
  } catch {
    return { allowed: true, remaining: limit, resetSeconds: windowSeconds };
  }
}

/**
 * The limits, by route family (§10).
 *
 * Generous enough that a person clicking around never meets them, tight enough
 * that a loop does. They are NOT the spend control: "check now" has its own
 * five-minute-per-target cooldown claimed against the target row, because that
 * one guards money and has to be exact. This guards effort.
 */
export const LIMITS = {
  /** Dashboard reads. A page load is a handful; a scraper is not. */
  read: { limit: 300, windowSeconds: 60 },
  /** Writes that change alert state. */
  write: { limit: 60, windowSeconds: 60 },
  /**
   * The paid one. The per-target cooldown already caps spend per keyword; this
   * caps what ONE principal can spend across ALL their keywords in an hour —
   * without it, a property with 200 targets is a $0.40 button press away from a
   * scripted loop.
   */
  spend: { limit: 60, windowSeconds: 3600 },
} as const satisfies Record<string, RateLimit>;

/**
 * The key a limit is counted against.
 *
 * The user id, never the email: this value is written to a table that is joined
 * in operational queries, and an email there is personal data sitting somewhere
 * nobody remembers to look.
 */
export function principalKey(principal: { userId: string } | null | undefined): string {
  return principal ? `user:${principal.userId}` : 'anonymous';
}

/** Consume a slot or raise a typed 429 carrying Retry-After. */
export async function enforceRateLimit(
  key: string,
  bucket: string,
  config: RateLimit,
): Promise<void> {
  const { allowed, resetSeconds } = await consume(key, bucket, config);

  if (!allowed) {
    throw new ApiFailure(
      'RATE_LIMITED',
      `Too many requests. Try again in ${resetSeconds}s.`,
      429,
      { 'Retry-After': String(resetSeconds) },
    );
  }
}

/** Delete windows that have long expired, so the table stays small. */
export async function pruneRateLimits(olderThanHours = 24): Promise<number> {
  const result = await db
    .delete(apiRateLimits)
    .where(
      and(
        sql`${apiRateLimits.windowStartedAt} < now() - (${olderThanHours} * interval '1 hour')`,
      ),
    )
    .returning({ key: apiRateLimits.principalKey });

  return result.length;
}
