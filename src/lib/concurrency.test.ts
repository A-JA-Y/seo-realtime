import { describe, expect, it } from 'vitest';

import { mapWithConcurrency, settleWithConcurrency } from './concurrency';

/** A task that records how many peers were in flight alongside it. */
function tracker(limit: number) {
  let inFlight = 0;
  let peak = 0;
  const run = async <T>(value: T, delayMs = 0): Promise<T> => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    inFlight--;
    return value;
  };
  return { run, peak: () => peak, limit };
}

describe('mapWithConcurrency', () => {
  it('returns results in INPUT order, not completion order', async () => {
    // Zipping results back against the input is how per-keyword rows get
    // attributed. Out-of-order results would assign one keyword's data to
    // another, silently.
    const items = [50, 10, 30, 0];
    const out = await mapWithConcurrency(items, 4, async (ms) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return ms;
    });

    expect(out).toEqual([50, 10, 30, 0]);
  });

  it('never exceeds the limit', async () => {
    const t = tracker(3);
    await mapWithConcurrency(Array.from({ length: 20 }, (_, i) => i), 3, (i) => t.run(i, 5));
    expect(t.peak()).toBeLessThanOrEqual(3);
  });

  it('actually runs concurrently up to the limit', async () => {
    const t = tracker(4);
    await mapWithConcurrency(Array.from({ length: 12 }, (_, i) => i), 4, (i) => t.run(i, 10));
    expect(t.peak()).toBe(4);
  });

  it('passes the index through', async () => {
    const out = await mapWithConcurrency(['a', 'b', 'c'], 2, async (item, i) => `${i}:${item}`);
    expect(out).toEqual(['0:a', '1:b', '2:c']);
  });

  it('handles an empty input', async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
  });

  it('handles fewer items than the limit', async () => {
    expect(await mapWithConcurrency([1, 2], 10, async (n) => n * 2)).toEqual([2, 4]);
  });

  it('rejects a nonsensical limit rather than spinning zero workers', async () => {
    await expect(mapWithConcurrency([1], 0, async (n) => n)).rejects.toThrow(/at least 1/);
  });

  it('propagates a rejection', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error('boom');
        return n;
      }),
    ).rejects.toThrow('boom');
  });
});

describe('settleWithConcurrency', () => {
  it('captures failures instead of aborting the batch', async () => {
    // One keyword's 403 must not cost the other twelve their hourly data.
    const out = await settleWithConcurrency([1, 2, 3, 4], 2, async (n) => {
      if (n % 2 === 0) throw new Error(`fail ${n}`);
      return n * 10;
    });

    expect(out.filter((r) => r.ok)).toHaveLength(2);
    expect(out.filter((r) => !r.ok)).toHaveLength(2);
    expect(out[0]).toMatchObject({ ok: true, index: 0, value: 10 });
    expect(out[1]).toMatchObject({ ok: false, index: 1 });
  });

  it('keeps input order for mixed outcomes', async () => {
    const out = await settleWithConcurrency([30, 0, 10], 3, async (ms, i) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      if (i === 1) throw new Error('x');
      return ms;
    });

    expect(out.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(out.map((r) => r.ok)).toEqual([true, false, true]);
  });
});
