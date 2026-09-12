/**
 * Bounded-concurrency map.
 *
 * Search Console's quota is 1,200 queries/minute per site and requests are
 * free, so the limit here is not about cost. It is about not turning one
 * property's backfill into a burst that trips rate limiting for every other
 * property sharing the run — and about keeping a serverless function's memory
 * and socket count predictable.
 *
 * Results are returned in INPUT order regardless of completion order. Callers
 * zip them back against the input array, so out-of-order results would silently
 * attribute one keyword's rows to another.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (limit < 1) throw new Error('mapWithConcurrency: limit must be at least 1');
  if (items.length === 0) return [];

  const results = new Array<R>(items.length);
  let cursor = 0;

  async function worker() {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T, index);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export type Settled<R> =
  | { ok: true; index: number; value: R }
  | { ok: false; index: number; error: unknown };

/**
 * Like `mapWithConcurrency`, but a rejection is captured rather than thrown.
 *
 * §12: "Never let one property's failure abort a multi-property job." The same
 * applies one level down — one keyword's 403 must not cost the other twelve
 * their hourly data. The caller inspects the outcomes and decides between
 * `success`, `partial` and `failed`.
 */
export async function settleWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<Array<Settled<R>>> {
  return mapWithConcurrency(items, limit, async (item, index) => {
    try {
      return { ok: true as const, index, value: await fn(item, index) };
    } catch (error) {
      return { ok: false as const, index, error };
    }
  });
}
