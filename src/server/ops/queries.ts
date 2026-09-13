import { sql } from 'drizzle-orm';

import { db } from '@/server/db';
import type { IngestKind, IngestStatus } from '@/server/db/schema';

/**
 * Raw `db.execute` returns timestamptz as a STRING.
 *
 * Unlike the typed `select()` path, which runs drizzle's column mapper, a raw
 * SQL result hands back whatever the driver produced — and the declared row
 * type is a promise the query cannot keep. Reading `.getTime()` off one throws
 * `date.getTime is not a function`, which on the /ops page means a 500 instead
 * of a dashboard. Parse once, here.
 */
function toDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Data for `/ops` (§12).
 *
 * "Surface the last 50 ingest_runs with status, duration, rows and cost, plus
 * cumulative DataForSEO spend for the current month. You are spending real
 * money on a schedule; make it visible."
 */

export interface IngestRunRow {
  id: string;
  kind: IngestKind;
  status: IngestStatus;
  propertyName: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  durationMs: number | null;
  rowsWritten: number;
  costUsd: number;
  error: string | null;
}

/**
 * Recent runs, capped PER KIND rather than globally.
 *
 * A flat `ORDER BY started_at DESC LIMIT 50` is dominated by whichever job runs
 * most often, and `serp_batch` opens one run per delivered pingback — roughly
 * 1,600 a day at the documented volume, one every ~54 seconds. The 50-row list
 * therefore spanned about 45 minutes, so a failed hourly `ingest-gsc` scrolled
 * off the page before anyone looked and the failure counter read zero. This is
 * the page §12 exists to make silent ingest death visible on.
 *
 * Per-kind means a chatty job can crowd out its own history but never anyone
 * else's, so every job's most recent runs — and its failures — are always on
 * screen.
 */
export async function recentIngestRuns(perKind = 12): Promise<IngestRunRow[]> {
  const result = await db.execute<{
    id: string;
    kind: IngestKind;
    status: IngestStatus;
    property_name: string | null;
    started_at: Date | string;
    finished_at: Date | string | null;
    duration_ms: number | null;
    rows_written: number;
    cost_usd: string;
    error: string | null;
  }>(sql`
    WITH ranked AS (
      SELECT
        r.id, r.kind, r.status, p.name AS property_name,
        r.started_at, r.finished_at,
        (EXTRACT(EPOCH FROM (r.finished_at - r.started_at)) * 1000)::int AS duration_ms,
        r.rows_written, r.cost_usd::text AS cost_usd, r.error,
        ROW_NUMBER() OVER (PARTITION BY r.kind ORDER BY r.started_at DESC) AS rn
      FROM ingest_runs r
      LEFT JOIN properties p ON p.id = r.property_id
    )
    SELECT id, kind, status, property_name, started_at, finished_at,
           duration_ms, rows_written, cost_usd, error
    FROM ranked
    WHERE rn <= ${perKind}
    ORDER BY started_at DESC
  `);

  return result.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    status: row.status,
    propertyName: row.property_name,
    startedAt: toDate(row.started_at) ?? new Date(0),
    finishedAt: toDate(row.finished_at),
    durationMs: row.duration_ms,
    rowsWritten: row.rows_written,
    // numeric crosses the driver as a string; parse once, here.
    costUsd: Number(row.cost_usd),
    error: row.error,
  }));
}

export interface SpendSummary {
  /** Authoritative: the sum of what the provider actually charged. */
  monthToDateUsd: number;
  checksThisMonth: number;
  /** What `ingest_runs` estimated, for comparison. */
  estimatedFromRunsUsd: number;
  /** Simple projection: month-to-date scaled to the whole month. */
  projectedMonthUsd: number;
}

/**
 * Month-to-date DataForSEO spend.
 *
 * Acceptance criterion 9 is explicit that `/ops` must agree with
 * `sum(serp_checks.cost_usd)` to within a cent, so that sum IS the figure —
 * not `ingest_runs.cost_usd`, which is an estimate recorded at submission
 * before the provider reports the real per-task cost.
 *
 * Both are returned. A gap between them means tasks were submitted and never
 * came back, which is exactly the silent failure §12 warns about.
 */
export async function monthToDateSpend(now: Date = new Date()): Promise<SpendSummary> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const [checks] = (
    await db.execute<{ total: string; n: number }>(sql`
      SELECT coalesce(sum(cost_usd), 0)::text AS total, count(*)::int AS n
      FROM serp_checks
      WHERE checked_at >= ${monthStart.toISOString()}
    `)
  ).rows;

  const [runs] = (
    await db.execute<{ total: string }>(sql`
      SELECT coalesce(sum(cost_usd), 0)::text AS total
      FROM ingest_runs
      WHERE started_at >= ${monthStart.toISOString()}
    `)
  ).rows;

  const monthToDateUsd = Number(checks?.total ?? 0);

  const daysElapsed = Math.max(
    1,
    (now.getTime() - monthStart.getTime()) / 86_400_000,
  );
  const daysInMonth = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0),
  ).getUTCDate();

  return {
    monthToDateUsd,
    checksThisMonth: checks?.n ?? 0,
    estimatedFromRunsUsd: Number(runs?.total ?? 0),
    projectedMonthUsd: (monthToDateUsd / daysElapsed) * daysInMonth,
  };
}

export interface IngestHealth {
  propertyId: string;
  propertyName: string;
  lastGscRowAt: Date | null;
  hoursSinceGscRow: number | null;
  /** §12: no GSC rows for 36 hours is a warning — silent ingest death. */
  gscStale: boolean;
  lastSerpCheckAt: Date | null;
  hoursSinceSerpCheck: number | null;
}

/** §12: "a warning when a property has received no GSC rows for 36 hours". */
export const GSC_STALE_HOURS = 36;

/**
 * Per-property freshness.
 *
 * §12 calls silent ingest death the most likely serious failure mode, and it is
 * silent precisely because a job that stops running produces no error — only an
 * absence. This turns the absence into a value someone can look at.
 */
export async function ingestHealth(): Promise<IngestHealth[]> {
  const result = await db.execute<{
    property_id: string;
    property_name: string;
    last_gsc_row_at: Date | string | null;
    last_serp_check_at: Date | string | null;
  }>(sql`
    SELECT
      p.id AS property_id,
      p.name AS property_name,
      (SELECT max(fetched_at) FROM gsc_snapshots g WHERE g.property_id = p.id) AS last_gsc_row_at,
      (SELECT max(checked_at) FROM serp_checks s WHERE s.property_id = p.id) AS last_serp_check_at
    FROM properties p
    WHERE p.is_active
    ORDER BY p.name
  `);

  const now = Date.now();
  const hoursSince = (date: Date | null) =>
    date === null ? null : (now - date.getTime()) / 3_600_000;

  return result.rows.map((row) => {
    const lastGscRowAt = toDate(row.last_gsc_row_at);
    const hoursSinceGscRow = hoursSince(lastGscRowAt);
    return {
      propertyId: row.property_id,
      propertyName: row.property_name,
      lastGscRowAt,
      hoursSinceGscRow,
      // A property that has NEVER produced a row is stale too — that is the
      // state a misconfigured property sits in, and it is the one most worth
      // catching.
      gscStale: hoursSinceGscRow === null || hoursSinceGscRow > GSC_STALE_HOURS,
      lastSerpCheckAt: toDate(row.last_serp_check_at),
      hoursSinceSerpCheck: hoursSince(toDate(row.last_serp_check_at)),
    };
  });
}
