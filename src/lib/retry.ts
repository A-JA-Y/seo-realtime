import { logger as rootLogger, type Logger } from './logger';
import { redactError } from './redact';

/**
 * Retry policy for external API calls.
 *
 * §7: "Wrap every external API call in a retry helper: 3 attempts, exponential
 * backoff with jitter, retrying only 429 and 5xx." §12 phrases the same rule as
 * "3 retries". The default here is 3 ATTEMPTS — one call plus two retries —
 * following §7's more precise wording; `attempts` is a parameter, so a caller
 * that wants §12's reading passes 4.
 *
 * §16 anti-pattern: never retry a 4xx other than 429.
 *
 * That asymmetry is the whole point. A 429 means "you were right, just slower";
 * a 400 means "you asked wrong" and retrying it burns quota to get the same
 * answer three times. In this codebase a 400 is also load-bearing: it is the
 * signal that triggers the Search Console dimension fallback, so swallowing it
 * in a retry loop would hide the one thing the caller needs to see.
 */

/** An HTTP failure carrying the status, so the policy can classify it. */
export class HttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | undefined;
  readonly body: string | undefined;

  constructor(
    message: string,
    status: number,
    options: { retryAfterMs?: number; body?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'HttpError';
    this.status = status;
    this.retryAfterMs = options.retryAfterMs;
    this.body = options.body;
  }
}

/**
 * Pull an HTTP status out of whatever the caller threw.
 *
 * Every client in this codebase reports failure differently: `fetch` gives a
 * Response we wrap in HttpError, google-auth-library throws a GaxiosError with
 * `.status` (older versions: `.response.status`, or only `.code`). Normalising
 * here means the policy has exactly one notion of "what went wrong".
 */
export function httpStatusOf(error: unknown): number | undefined {
  if (error instanceof HttpError) return error.status;
  if (typeof error !== 'object' || error === null) return undefined;

  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    response?: { status?: unknown };
  };

  for (const value of [candidate.status, candidate.statusCode, candidate.response?.status, candidate.code]) {
    if (typeof value === 'number' && value >= 100 && value <= 599) return value;
    // Gaxios sometimes stringifies the status into `code`.
    if (typeof value === 'string' && /^\d{3}$/.test(value)) return Number(value);
  }

  return undefined;
}

/**
 * A failure with no HTTP status at all — DNS, connection reset, TLS, timeout.
 *
 * These are retried by default because they are exactly what retries exist for,
 * but the caller can turn that off. That matters for non-idempotent writes:
 * DataForSEO's `task_post` charges per task, and a connection reset after the
 * server accepted the request would double-bill on retry.
 */
export function isNetworkError(error: unknown): boolean {
  if (httpStatusOf(error) !== undefined) return false;
  if (!(error instanceof Error)) return false;

  const code = (error as Error & { code?: unknown }).code;
  if (typeof code === 'string') {
    return /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|UND_ERR_)/.test(
      code,
    );
  }

  return /fetch failed|network|socket hang up|timed? ?out/i.test(error.message);
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

export interface RetryOptions {
  /** Total attempts including the first. Default 3. */
  attempts?: number;
  /** First backoff, doubled each attempt. Default 500ms. */
  baseDelayMs?: number;
  /** Ceiling for a single backoff, before jitter. Default 10s. */
  maxDelayMs?: number;
  /** Retry connection-level failures that carry no status. Default true. */
  retryNetworkErrors?: boolean;
  /**
   * Override which statuses are retried. Defaults to 429 and 5xx.
   *
   * Narrowed to 429 only for calls that are billed on acceptance: a 502 or 504
   * can arrive AFTER the backend took the request, so retrying pays twice.
   */
  isRetryableStatus?: (status: number) => boolean;
  /**
   * What is being called, for the log line. Endpoint paths, not URLs with
   * query strings — a query string is where a secret ends up.
   */
  label?: string;
  /**
   * Where the retry warning goes. Defaults to the root logger, which already
   * redacts; pass a child to inherit a run_id.
   *
   * Retries were previously invisible: `label` was accepted and dropped, and
   * `onRetry` had no production consumer, so nothing anywhere recorded that a
   * call had been retried. Retry pressure is the earliest signal that a
   * provider is degrading, and it was going straight to the floor.
   */
  logger?: Logger;
  /** Called before each retry, in addition to the log line. */
  onRetry?: (info: {
    attempt: number;
    delayMs: number;
    status?: number;
    error: string;
    label: string;
  }) => void;
  /** Injected for tests — real timers make a retry suite take seconds. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected for tests — jitter must be deterministic under test. */
  random?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Full jitter: a uniform draw from [0, exponential backoff].
 *
 * Not "backoff ± a bit". When N callers are throttled simultaneously, equal
 * backoff re-synchronises them into the same retry spike that caused the 429.
 * Full jitter spreads them across the whole window, which is the only variant
 * that actually decorrelates the herd.
 */
export function backoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number,
): number {
  const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.round(random() * exponential);
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    attempts = 3,
    baseDelayMs = 500,
    maxDelayMs = 10_000,
    retryNetworkErrors = true,
    isRetryableStatus: retryableStatus = isRetryableStatus,
    label = 'external call',
    logger = rootLogger,
    onRetry,
    sleep = defaultSleep,
    random = Math.random,
  } = options;

  if (attempts < 1) throw new Error('withRetry: attempts must be at least 1');

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      const status = httpStatusOf(error);
      const retryable =
        status === undefined ? retryNetworkErrors && isNetworkError(error) : retryableStatus(status);

      // A 400/401/403/404 is a permanent answer. Rethrow immediately so the
      // caller sees the real status — the dimension fallback depends on it.
      if (!retryable || attempt === attempts) throw error;

      /*
       * Honour Retry-After when the server sent one; it knows better than our
       * exponential guess.
       *
       * Still jittered. Every throttled caller receives the SAME Retry-After
       * value, so obeying it exactly re-synchronises the whole fleet into one
       * spike at that instant — the herd this policy exists to break up. The
       * jitter here is additive and one-sided (wait at least as long as asked,
       * up to 20% longer) rather than the full jitter used for our own backoff,
       * because waiting LESS than the server asked for is not ours to choose.
       */
      const suggested = error instanceof HttpError ? error.retryAfterMs : undefined;
      const delayMs =
        suggested !== undefined
          ? Math.min(Math.round(suggested * (1 + 0.2 * random())), maxDelayMs)
          : backoffDelay(attempt, baseDelayMs, maxDelayMs, random);

      const info = {
        attempt,
        delayMs,
        ...(status === undefined ? {} : { status }),
        error: redactError(error),
        label,
      };

      logger.warn('retrying an external call', {
        label,
        attempt,
        of: attempts,
        delay_ms: delayMs,
        ...(status === undefined ? {} : { status }),
        error: info.error,
      });

      onRetry?.(info);

      await sleep(delayMs);
    }
  }

  /* istanbul ignore next — the loop either returns or throws. */
  throw lastError;
}

/** Parse a `Retry-After` header, which may be seconds or an HTTP date. */
export function parseRetryAfter(header: string | null, now: Date = new Date()): number | undefined {
  if (!header) return undefined;

  // A purely numeric header is delta-seconds. Decide it entirely here: falling
  // through to Date.parse on a negative number gets a nonsense date accepted
  // (Date.parse('-5') is a valid year), which then clamps to 0 and retries
  // instantly — a hot loop against a server that just asked us to slow down.
  const trimmed = header.trim();
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return seconds >= 0 ? Math.round(seconds * 1000) : undefined;
  }

  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;

  return Math.max(0, date - now.getTime());
}

/**
 * Build an HttpError from a fetch Response, consuming the body for context.
 * Truncated, because an HTML error page is not worth carrying around.
 */
export async function httpErrorFromResponse(response: Response, label: string): Promise<HttpError> {
  let body: string | undefined;
  try {
    body = (await response.text()).slice(0, 1000);
  } catch {
    body = undefined;
  }

  return new HttpError(`${label}: HTTP ${response.status} ${response.statusText}`.trim(), response.status, {
    ...(body === undefined ? {} : { body }),
    ...(() => {
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
      return retryAfterMs === undefined ? {} : { retryAfterMs };
    })(),
  });
}
