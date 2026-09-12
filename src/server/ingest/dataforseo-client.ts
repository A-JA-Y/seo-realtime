import { z } from 'zod';

import { dataForSeoAuthHeader } from '@/lib/env';
import { httpErrorFromResponse, withRetry, type RetryOptions } from '@/lib/retry';
import { serpEnvelopeSchema, type SerpEnvelope } from './serp-parse';

/**
 * DataForSEO Google Organic SERP client (§6).
 *
 * HTTP Basic with the API password from the dashboard — NOT the account login
 * password. `dataForSeoAuthHeader()` builds the credential inside
 * `src/lib/env.ts` so the raw password never travels further into the codebase.
 */

export const DATAFORSEO_BASE_URL = 'https://api.dataforseo.com';

/** §17, verified pricing. These drive the cost estimate recorded on every run. */
export const COST_PER_SERP = {
  /** ~5 minutes. What scheduled tracking uses. */
  standard: 0.0006,
  /** ~1 minute. Unused — 2x the price for turnaround a cron does not care about. */
  priority: 0.0012,
  /** ~6 seconds. ONLY for the dashboard's "check now", where a person is waiting. */
  live: 0.002,
} as const;

/** §17: "Max tasks per task_post: 100." */
export const MAX_TASKS_PER_POST = 100;

/**
 * DataForSEO signals failure in two places, and both must be checked.
 *
 * The HTTP status and the envelope `status_code` can both be success while an
 * individual TASK carries an error — a bad `location_code`, a handler timeout.
 * Treating a 200 as "it worked" silently drops those keywords.
 */
export const STATUS = {
  ok: 20000,
  taskCreated: 20100,
  taskInQueue: 40602,
  taskNotFound: 40401,
} as const;

export function isTaskOk(statusCode: number): boolean {
  return statusCode === STATUS.ok || statusCode === STATUS.taskCreated;
}

/* ══════════════════════════════════════════════════════════════════════════
   Request shapes
   ══════════════════════════════════════════════════════════════════════════ */

export interface SerpTaskRequest {
  keyword: string;
  /** Resolved from /v3/serp/google/locations. NEVER hardcoded — §16. */
  location_code: number;
  language_code: string;
  device: 'desktop' | 'mobile';
  os: 'windows' | 'android';
  /** 100, so "not in the top 100" is a real recorded state rather than a miss. */
  depth: number;
  /** Carries our keyword_target_id, so the webhook routes without a lookup. */
  tag: string;
  pingback_url?: string;
}

/* ══════════════════════════════════════════════════════════════════════════
   Additional response schemas
   ══════════════════════════════════════════════════════════════════════════ */

export const userDataSchema = z.object({
  status_code: z.number(),
  tasks: z
    .array(
      z.object({
        status_code: z.number(),
        result: z
          .array(
            z.object({
              money: z
                .object({ balance: z.number(), total: z.number().optional() })
                .nullable()
                .optional(),
            }),
          )
          .nullable()
          .optional(),
      }),
    )
    .nullable()
    .optional(),
});

export type DataForSeoLocation = z.infer<typeof locationRowSchema>;

const locationRowSchema = z.object({
  location_code: z.number(),
  location_name: z.string(),
  location_type: z.string().nullable().optional(),
  country_iso_code: z.string().nullable().optional(),
});

export const locationsSchema = z.object({
  status_code: z.number(),
  tasks: z
    .array(
      z.object({
        status_code: z.number(),
        result: z.array(locationRowSchema).nullable().optional(),
      }),
    )
    .nullable()
    .optional(),
});

/* ══════════════════════════════════════════════════════════════════════════
   Client
   ══════════════════════════════════════════════════════════════════════════ */

export interface DataForSeoClient {
  /** Queue up to 100 SERP tasks in one request. Returns the envelope. */
  taskPost(tasks: readonly SerpTaskRequest[]): Promise<SerpEnvelope>;
  /** Collect a completed task by id. */
  taskGetAdvanced(taskId: string): Promise<SerpEnvelope>;
  /** Synchronous SERP. $0.0020 — only for "check now". */
  liveAdvanced(task: SerpTaskRequest): Promise<SerpEnvelope>;
  balance(): Promise<number | null>;
  locations(): Promise<DataForSeoLocation[]>;
}

export interface DataForSeoClientOptions {
  fetchImpl?: typeof fetch;
  retry?: RetryOptions;
  baseUrl?: string;
  /** Injected for tests so no credential is needed. */
  authHeader?: () => string;
}

export function createDataForSeoClient(options: DataForSeoClientOptions = {}): DataForSeoClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl ?? DATAFORSEO_BASE_URL;
  const authHeader = options.authHeader ?? dataForSeoAuthHeader;

  async function call<T>(
    path: string,
    schema: z.ZodType<T>,
    init: { method: 'GET' | 'POST'; body?: unknown; retry?: RetryOptions },
  ): Promise<T> {
    return withRetry(
      async () => {
        const response = await fetchImpl(`${baseUrl}${path}`, {
          method: init.method,
          headers: {
            Authorization: authHeader(),
            ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        });

        if (response.status === 401) {
          throw await httpErrorFromResponse(
            response,
            `${path}: credentials rejected — DATAFORSEO_PASSWORD must be the API password from ` +
              'the dashboard, which is not your account login password',
          );
        }

        if (!response.ok) throw await httpErrorFromResponse(response, path);

        const parsed = schema.safeParse(await response.json());
        if (!parsed.success) {
          throw new Error(
            `${path}: unexpected response shape — ${parsed.error.issues
              .slice(0, 3)
              .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
              .join('; ')}`,
          );
        }

        return parsed.data;
      },
      { label: path, ...options.retry, ...init.retry },
    );
  }

  return {
    async taskPost(tasks) {
      if (tasks.length === 0) throw new Error('taskPost called with no tasks');
      if (tasks.length > MAX_TASKS_PER_POST) {
        throw new Error(
          `taskPost accepts at most ${MAX_TASKS_PER_POST} tasks, got ${tasks.length}`,
        );
      }

      return call('/v3/serp/google/organic/task_post', serpEnvelopeSchema, {
        method: 'POST',
        body: tasks,
        /*
         * task_post is billed on acceptance, which makes almost every retry
         * unsafe. A connection reset, a 502 from a gateway, or a 504 timeout can
         * all occur AFTER the backend took the batch — retrying then pays for
         * every task twice with no second set of results.
         *
         * Only 429 is safe: it means the request was refused outright, never
         * queued. So: no network retries, and no 5xx retries either.
         */
        retry: { retryNetworkErrors: false, isRetryableStatus: (s) => s === 429 },
      });
    },

    async taskGetAdvanced(taskId) {
      return call(
        `/v3/serp/google/organic/task_get/advanced/${encodeURIComponent(taskId)}`,
        serpEnvelopeSchema,
        { method: 'GET' },
      );
    },

    async liveAdvanced(task) {
      return call('/v3/serp/google/organic/live/advanced', serpEnvelopeSchema, {
        method: 'POST',
        body: [task],
        // Live is billed per call, and the same ambiguity applies: a 5xx may
        // arrive after the SERP was fetched and charged.
        retry: { retryNetworkErrors: false, isRetryableStatus: (s) => s === 429 },
      });
    },

    async balance() {
      const data = await call('/v3/appendix/user_data', userDataSchema, { method: 'GET' });
      return data.tasks?.[0]?.result?.[0]?.money?.balance ?? null;
    },

    async locations() {
      const data = await call('/v3/serp/google/locations', locationsSchema, { method: 'GET' });
      return data.tasks?.[0]?.result ?? [];
    },
  };
}

/**
 * Build the pingback URL DataForSEO calls when a task completes.
 *
 * `$id` is substituted by DataForSEO with the task id. The secret guards the
 * route: without it the ingest endpoint is a public button that spends the
 * account balance, which is why §6 opens with that check.
 */
export function buildPingbackUrl(appBaseUrl: string, secret: string): string {
  const base = appBaseUrl.replace(/\/+$/, '');
  // $id must survive un-encoded — DataForSEO substitutes the literal token.
  return `${base}/api/webhooks/dataforseo?secret=${encodeURIComponent(secret)}&id=$id`;
}
