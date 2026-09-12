import { JWT } from 'google-auth-library';
import { z } from 'zod';

import { requireEnv } from '@/lib/env';
import type { DateString } from '@/lib/gsc-dates';
import { httpErrorFromResponse, withRetry, type RetryOptions } from '@/lib/retry';

/**
 * Search Console Search Analytics client.
 *
 * Goes through `fetch` with a JWT-issued bearer token rather than Gaxios's own
 * `auth.request`, for one reason: the hourly ingest's dimension fallback keys
 * off an exact HTTP 400, and a real `Response` gives an unambiguous status and
 * body. Gaxios normalises errors differently across versions, and guessing
 * wrong there would turn "fall back to the per-date shape" into "silently stop
 * ingesting".
 */

const SCOPES = ['https://www.googleapis.com/auth/webmasters.readonly'];
const API_BASE = 'https://www.googleapis.com/webmasters/v3';

/* ══════════════════════════════════════════════════════════════════════════
   Request types
   ══════════════════════════════════════════════════════════════════════════ */

/** Dimensions this codebase uses. Google also supports country/device/page/searchAppearance. */
export type GscDimension = 'date' | 'hour' | 'query' | 'country' | 'device' | 'page';

/**
 * `final` — settled, ~2-3 day lag.
 * `all` — includes fresh partial daily data Google will revise.
 * `hourly_all` — hourly buckets; per Google's reference, the value to use when
 *                grouping by HOUR.
 */
export type GscDataStateParam = 'final' | 'all' | 'hourly_all';

export interface SearchAnalyticsQuery {
  startDate: DateString;
  endDate: DateString;
  dimensions: GscDimension[];
  dataState: GscDataStateParam;
  rowLimit?: number;
  startRow?: number;
  dimensionFilterGroups?: Array<{
    groupType?: 'and';
    filters: Array<{
      dimension: GscDimension;
      operator: 'equals' | 'contains' | 'notContains' | 'notEquals';
      expression: string;
    }>;
  }>;
}

/* ══════════════════════════════════════════════════════════════════════════
   Response schemas — external data is validated, never coerced
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * One Search Analytics row.
 *
 * Every metric is optional because Google omits them rather than sending zero,
 * and `position` is genuinely absent for a row with no impressions. Defaults
 * are applied at the parse boundary so downstream code never sees `undefined`
 * — except for `position`, which stays nullable all the way to the database.
 * A missing position is information (domain rule 5's principle applied to GSC),
 * not something to fill in with 0.
 *
 * Unknown keys are stripped rather than rejected. Google adds response fields
 * without notice, and a strict schema would turn a harmless addition into a
 * total ingest outage. What is NOT tolerated is a field of the wrong type —
 * that is a real shape change and coercing it would fabricate numbers.
 */
export const gscRowSchema = z.object({
  keys: z.array(z.string()).default([]),
  clicks: z.number().finite().nonnegative().default(0),
  impressions: z.number().finite().nonnegative().default(0),
  ctr: z.number().finite().nonnegative().default(0),
  position: z.number().finite().positive().optional(),
});

export type GscRow = z.infer<typeof gscRowSchema>;

export const searchAnalyticsResponseSchema = z.object({
  rows: z.array(gscRowSchema).default([]),
  responseAggregationType: z.string().optional(),
});

export type SearchAnalyticsResponse = z.infer<typeof searchAnalyticsResponseSchema>;

export const sitesListResponseSchema = z.object({
  siteEntry: z
    .array(
      z.object({
        siteUrl: z.string(),
        permissionLevel: z.string(),
      }),
    )
    .default([]),
});

/* ══════════════════════════════════════════════════════════════════════════
   Dimension key parsing
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Extract the hour from an `hour` dimension key.
 *
 * Google returns this in two shapes depending on the request, and the ingest
 * must survive both:
 *
 *   "13"                          bare hour
 *   "2026-09-12T13:00:00-07:00"   ISO timestamp at Pacific offset
 *
 * The hour is taken LITERALLY out of the string. It is not parsed into a Date
 * and re-read, because doing that converts through the runtime's local zone and
 * silently shifts the hour — the exact class of bug domain rule 4 forbids. The
 * string already carries Pacific local time; we want the digits as written.
 */
export function parseHourKey(key: string): number | null {
  const bare = /^([01]?\d|2[0-3])$/.exec(key.trim());
  if (bare) return Number(bare[1]);

  const iso = /^\d{4}-\d{2}-\d{2}[T ]([01]\d|2[0-3]):/.exec(key.trim());
  if (iso) return Number(iso[1]);

  return null;
}

/**
 * Extract the Pacific date from a `date` or `hour` dimension key.
 *
 * Same rule: the literal `YYYY-MM-DD` prefix, never a Date round trip. When
 * Google returns the hour key as a full timestamp it already carries the date,
 * which is what lets the per-date fallback recover the date without the `date`
 * dimension being present at all.
 */
export function parseDateKey(key: string): DateString | null {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(key.trim());
  return match ? (match[1] as DateString) : null;
}

/* ══════════════════════════════════════════════════════════════════════════
   Client
   ══════════════════════════════════════════════════════════════════════════ */

export interface GscClient {
  listSites(): Promise<Array<{ siteUrl: string; permissionLevel: string }>>;
  searchAnalytics(siteUrl: string, query: SearchAnalyticsQuery): Promise<SearchAnalyticsResponse>;
}

export interface GscClientOptions {
  /** Injected for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injected for tests, so a retry suite does not sleep on real timers. */
  retry?: RetryOptions;
  /** Injected for tests. Defaults to a JWT built from the service-account env. */
  authorize?: (url: string) => Promise<Headers>;
}

/**
 * A JWT for the service account.
 *
 * The private key arrives already unescaped from `src/lib/env.ts` — the single
 * place that handles the `\n` problem, so no call site has to remember it.
 */
export function gscJwt(): JWT {
  const { GOOGLE_SERVICE_ACCOUNT_EMAIL, GOOGLE_PRIVATE_KEY } = requireEnv(
    'GOOGLE_SERVICE_ACCOUNT_EMAIL',
    'GOOGLE_PRIVATE_KEY',
  );

  return new JWT({
    email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: GOOGLE_PRIVATE_KEY,
    scopes: SCOPES,
  });
}

/**
 * Search Console requires the site identifier URL-encoded in the path, and the
 * string must match what Search Console holds EXACTLY — trailing slash for a
 * URL-prefix property, `sc-domain:` prefix for a domain property. A mismatch
 * reads as `403 User does not have sufficient permission for site`, which looks
 * like a permissions bug and is a string bug.
 */
export function encodeSiteUrl(siteUrl: string): string {
  return encodeURIComponent(siteUrl);
}

export function createGscClient(options: GscClientOptions = {}): GscClient {
  const fetchImpl = options.fetchImpl ?? fetch;

  let jwt: JWT | null = null;
  const authorize =
    options.authorize ??
    (async (url: string) => {
      jwt ??= gscJwt();
      return jwt.getRequestHeaders(url);
    });

  async function request<T>(
    url: string,
    schema: z.ZodType<T>,
    init: { method: 'GET' | 'POST'; body?: unknown },
    label: string,
  ): Promise<T> {
    return withRetry(async () => {
      const headers = await authorize(url);
      if (init.body !== undefined) headers.set('content-type', 'application/json');

      const response = await fetchImpl(url, {
        method: init.method,
        headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });

      // Non-2xx becomes an HttpError carrying the status. `withRetry` retries
      // 429/5xx and rethrows everything else immediately — which is what lets
      // the caller see a 400 and switch dimension shapes.
      if (!response.ok) throw await httpErrorFromResponse(response, label);

      const json: unknown = await response.json();
      const parsed = schema.safeParse(json);

      if (!parsed.success) {
        // §5: "Reject and log anything unexpected rather than coercing."
        // Coercion here would invent numbers, which is worse than failing.
        throw new Error(
          `${label}: unexpected response shape — ${parsed.error.issues
            .slice(0, 3)
            .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('; ')}`,
        );
      }

      return parsed.data;
    }, { label, ...options.retry });
  }

  return {
    async listSites() {
      const result = await request(
        `${API_BASE}/sites`,
        sitesListResponseSchema,
        { method: 'GET' },
        'sites.list',
      );
      return result.siteEntry;
    },

    async searchAnalytics(siteUrl, query) {
      return request(
        `${API_BASE}/sites/${encodeSiteUrl(siteUrl)}/searchAnalytics/query`,
        searchAnalyticsResponseSchema,
        { method: 'POST', body: query },
        'searchAnalytics.query',
      );
    },
  };
}

/**
 * Build the filter that pins a request to one keyword.
 *
 * Google "does not guarantee to return all data rows but rather top ones", so
 * fetching everything and searching client-side will silently miss a keyword
 * that falls outside the top slice. One filtered request per keyword is the
 * only reliable shape — and requests are free at 1,200/minute per site.
 */
export function exactQueryFilter(term: string): SearchAnalyticsQuery['dimensionFilterGroups'] {
  return [
    {
      groupType: 'and',
      filters: [{ dimension: 'query', operator: 'equals', expression: term }],
    },
  ];
}

/** Google's maximum, and the value §5 specifies. */
export const GSC_ROW_LIMIT = 25_000;
