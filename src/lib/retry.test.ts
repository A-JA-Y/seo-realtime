import { describe, expect, it, vi } from 'vitest';

import {
  HttpError,
  backoffDelay,
  httpErrorFromResponse,
  httpStatusOf,
  isNetworkError,
  isRetryableStatus,
  parseRetryAfter,
  withRetry,
} from './retry';

/** No real timers — a retry suite on real backoff takes seconds. */
const noSleep = () => Promise.resolve();
/** Deterministic jitter: full jitter at its maximum draw. */
const maxJitter = () => 1;

function failing(times: number, error: unknown, result: unknown = 'ok') {
  let calls = 0;
  const fn = vi.fn(async () => {
    calls++;
    if (calls <= times) throw error;
    return result;
  });
  return fn;
}

describe('httpStatusOf', () => {
  it('reads HttpError', () => {
    expect(httpStatusOf(new HttpError('x', 429))).toBe(429);
  });

  it('reads the shapes google-auth-library and fetch wrappers actually throw', () => {
    expect(httpStatusOf({ status: 503 })).toBe(503);
    expect(httpStatusOf({ statusCode: 500 })).toBe(500);
    expect(httpStatusOf({ response: { status: 400 } })).toBe(400);
    expect(httpStatusOf({ code: 429 })).toBe(429);
    expect(httpStatusOf({ code: '400' })).toBe(400);
  });

  it('does not mistake a POSIX error code for a status', () => {
    expect(httpStatusOf({ code: 'ECONNRESET' })).toBeUndefined();
    expect(httpStatusOf(new Error('boom'))).toBeUndefined();
    expect(httpStatusOf(null)).toBeUndefined();
    expect(httpStatusOf('500')).toBeUndefined();
  });

  it('ignores numbers outside the HTTP range', () => {
    expect(httpStatusOf({ code: -111 })).toBeUndefined();
    expect(httpStatusOf({ status: 99 })).toBeUndefined();
  });
});

describe('isRetryableStatus', () => {
  it('retries 429 and 5xx only', () => {
    expect(isRetryableStatus(429)).toBe(true);
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(599)).toBe(true);
  });

  it('does not retry any other 4xx', () => {
    for (const status of [400, 401, 403, 404, 409, 422, 428]) {
      expect(isRetryableStatus(status), `status ${status}`).toBe(false);
    }
  });

  it('does not retry 2xx or 3xx', () => {
    expect(isRetryableStatus(200)).toBe(false);
    expect(isRetryableStatus(301)).toBe(false);
  });
});

describe('isNetworkError', () => {
  it('recognises connection-level failures', () => {
    expect(isNetworkError(Object.assign(new Error('read'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isNetworkError(Object.assign(new Error('dns'), { code: 'EAI_AGAIN' }))).toBe(true);
    expect(isNetworkError(new Error('fetch failed'))).toBe(true);
    expect(isNetworkError(new Error('socket hang up'))).toBe(true);
  });

  it('does not classify an HTTP failure as a network error', () => {
    expect(isNetworkError(new HttpError('x', 500))).toBe(false);
    expect(isNetworkError({ status: 503 })).toBe(false);
  });

  it('does not classify an arbitrary error as a network error', () => {
    expect(isNetworkError(new Error('bad json'))).toBe(false);
    expect(isNetworkError('string')).toBe(false);
  });
});

describe('withRetry', () => {
  it('returns the first successful result without sleeping', async () => {
    const sleep = vi.fn(noSleep);
    const fn = vi.fn(async () => 'ok');

    await expect(withRetry(fn, { sleep })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries a 429 and succeeds', async () => {
    const fn = failing(1, new HttpError('throttled', 429));
    await expect(withRetry(fn, { sleep: noSleep, random: maxJitter })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries a 503 up to 3 total attempts, then rethrows', async () => {
    const error = new HttpError('down', 503);
    const fn = failing(99, error);

    await expect(withRetry(fn, { sleep: noSleep, random: maxJitter })).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a 400 — the fallback path depends on seeing it', async () => {
    // The Search Console dimension probe treats a 400 as its signal. A retry
    // loop that swallowed it would hide the one thing the caller needs.
    const error = new HttpError('bad dimensions', 400);
    const fn = failing(99, error);

    await expect(withRetry(fn, { sleep: noSleep })).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry 401/403/404', async () => {
    for (const status of [401, 403, 404]) {
      const fn = failing(99, new HttpError('nope', status));
      await expect(withRetry(fn, { sleep: noSleep })).rejects.toThrow();
      expect(fn, `status ${status}`).toHaveBeenCalledTimes(1);
    }
  });

  it('retries a network error by default', async () => {
    const fn = failing(1, Object.assign(new Error('reset'), { code: 'ECONNRESET' }));
    await expect(withRetry(fn, { sleep: noSleep, random: maxJitter })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('can be told not to retry network errors, for non-idempotent writes', async () => {
    // DataForSEO task_post charges per task. A reset after the server accepted
    // the request would double-bill on retry.
    const error = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    const fn = failing(99, error);

    await expect(withRetry(fn, { sleep: noSleep, retryNetworkErrors: false })).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('backs off exponentially between attempts', async () => {
    const delays: number[] = [];
    const fn = failing(99, new HttpError('down', 500));

    await expect(
      withRetry(fn, {
        attempts: 4,
        baseDelayMs: 100,
        sleep: async (ms) => void delays.push(ms),
        random: maxJitter,
      }),
    ).rejects.toThrow();

    expect(delays).toEqual([100, 200, 400]);
  });

  it('caps the backoff at maxDelayMs', async () => {
    const delays: number[] = [];
    const fn = failing(99, new HttpError('down', 500));

    await expect(
      withRetry(fn, {
        attempts: 5,
        baseDelayMs: 1000,
        maxDelayMs: 2500,
        sleep: async (ms) => void delays.push(ms),
        random: maxJitter,
      }),
    ).rejects.toThrow();

    expect(delays).toEqual([1000, 2000, 2500, 2500]);
  });

  it('honours Retry-After over its own exponential guess', async () => {
    const delays: number[] = [];
    const fn = failing(1, new HttpError('slow down', 429, { retryAfterMs: 1500 }));

    await withRetry(fn, {
      baseDelayMs: 100,
      sleep: async (ms) => void delays.push(ms),
      random: () => 0,
    });

    // The server's figure, not our 100ms exponential guess.
    expect(delays).toEqual([1500]);
  });

  it('never waits LESS than Retry-After asked for, but may wait a little longer', async () => {
    // Every throttled caller receives the SAME Retry-After, so obeying it
    // exactly re-synchronises the fleet into one spike at that instant — the
    // herd this policy exists to break up. The jitter is one-sided: waiting
    // less than the server asked is not ours to choose.
    for (const draw of [0, 0.25, 0.5, 1]) {
      const delays: number[] = [];
      const fn = failing(1, new HttpError('slow down', 429, { retryAfterMs: 1000 }));

      await withRetry(fn, { sleep: async (ms) => void delays.push(ms), random: () => draw });

      expect(delays[0], `draw ${draw}`).toBeGreaterThanOrEqual(1000);
      expect(delays[0], `draw ${draw}`).toBeLessThanOrEqual(1200);
    }
  });

  it('still caps a Retry-After that asks for an absurd wait', async () => {
    const delays: number[] = [];
    const fn = failing(1, new HttpError('slow down', 429, { retryAfterMs: 3_600_000 }));

    await withRetry(fn, {
      maxDelayMs: 5000,
      sleep: async (ms) => void delays.push(ms),
      random: maxJitter,
    });
    expect(delays).toEqual([5000]);
  });

  it('reports each retry without leaking secrets', async () => {
    const seen: Array<{ attempt: number; status?: number; error: string }> = [];
    const fn = failing(
      1,
      new HttpError('failed for postgresql://u:hunter2@db.neon.tech/main', 500),
    );

    await withRetry(fn, {
      sleep: noSleep,
      random: maxJitter,
      onRetry: (info) => seen.push(info),
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.attempt).toBe(1);
    expect(seen[0]!.status).toBe(500);
    expect(seen[0]!.error).not.toContain('hunter2');
  });

  it('rejects a nonsensical attempt count rather than silently never calling fn', async () => {
    await expect(withRetry(async () => 'x', { attempts: 0 })).rejects.toThrow(/at least 1/);
  });
});

describe('backoffDelay — full jitter', () => {
  it('draws uniformly from [0, exponential], not exponential ± epsilon', () => {
    // Equal backoff re-synchronises a throttled fleet into the spike that
    // caused the 429. Full jitter is the variant that decorrelates it.
    expect(backoffDelay(1, 1000, 30_000, () => 0)).toBe(0);
    expect(backoffDelay(1, 1000, 30_000, () => 1)).toBe(1000);
    expect(backoffDelay(1, 1000, 30_000, () => 0.5)).toBe(500);
    expect(backoffDelay(3, 1000, 30_000, () => 1)).toBe(4000);
    expect(backoffDelay(10, 1000, 30_000, () => 1)).toBe(30_000);
  });
});

describe('parseRetryAfter', () => {
  const now = new Date('2026-09-12T12:00:00Z');

  it('parses delta-seconds', () => {
    expect(parseRetryAfter('120', now)).toBe(120_000);
    expect(parseRetryAfter('0', now)).toBe(0);
  });

  it('parses an HTTP date', () => {
    expect(parseRetryAfter('Sat, 12 Sep 2026 12:00:30 GMT', now)).toBe(30_000);
  });

  it('clamps a date already in the past to zero', () => {
    expect(parseRetryAfter('Sat, 12 Sep 2026 11:59:00 GMT', now)).toBe(0);
  });

  it('returns undefined for absent or unparseable values', () => {
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter('-5', now)).toBeUndefined();
  });
});

describe('httpErrorFromResponse', () => {
  it('carries status, truncated body and Retry-After', async () => {
    const response = new Response('x'.repeat(5000), {
      status: 429,
      statusText: 'Too Many Requests',
      headers: { 'retry-after': '30' },
    });

    const error = await httpErrorFromResponse(response, 'task_post');

    expect(error.status).toBe(429);
    expect(error.retryAfterMs).toBe(30_000);
    expect(error.body).toHaveLength(1000);
    expect(error.message).toContain('task_post');
  });

  it('survives a body that cannot be read', async () => {
    const response = new Response(null, { status: 500 });
    await response.text();
    const error = await httpErrorFromResponse(response, 'x');
    expect(error.status).toBe(500);
  });
});
