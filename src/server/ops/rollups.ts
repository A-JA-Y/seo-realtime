import { sql } from 'drizzle-orm';

import type { Logger } from '@/lib/logger';
import { db } from '@/server/db';
import { withIngestRun } from '@/server/ingest/runs';

/**
 * Daily rank rollups (§6 retention, §9 alert baselines).
 *
 * Two jobs in one table. Storage control: per-check rows are deleted after 90
 * days, and these survive so a year-old trend line still renders. And alert
 * baselines: §9 says "Baselines come from daily_rank_rollups, using
 * best_rank_group, never a single check — one check is too noisy to alert on."
 */

/**
 * The day a check belongs to, in the PROPERTY's timezone.
 *
 * `checked_at` is a timestamptz and a day has to be cut somewhere. The property
 * timezone is the only defensible choice: "moved today" has to mean what the
 * client means by today, and grouping a Noida property's checks by UTC days
 * would split every Indian evening across two rollup rows.
 *
 * This is NOT the Pacific-date rule from domain rule 4 — that governs Search
 * Console dates, which Google assigns. These are our own timestamps.
 */
const ROLLUP_DAY = sql`(serp_checks.checked_at AT TIME ZONE properties.timezone)::date`;

export interface RollupResult {
  daysWritten: number;
  from: string;
  to: string;
}

/**
 * Build or refresh rollups for every day with checks in the window.
 *
 * Idempotent by the same rule as every other ingest: the natural key is
 * `(keyword_target_id, day)` and the write is `ON CONFLICT DO UPDATE`. Re-running
 * recomputes from the per-check rows, so a late-arriving pingback for yesterday
 * is picked up by tomorrow's run rather than being lost.
 *
 * The aggregates deliberately exclude not-found checks from the rank columns:
 * `rank_group` is NULL there, and Postgres MIN/MAX/AVG skip NULLs. A miss is
 * counted in `checks_count` but not in `found_count`, which is what lets the UI
 * say "found in 3 of 4 checks" instead of inventing a position for the fourth.
 */
export async function buildDailyRollups(options: {
  /** Inclusive lower bound, `YYYY-MM-DD`. Defaults to 7 days back. */
  from?: string;
  /** Inclusive upper bound, `YYYY-MM-DD`. Defaults to today. */
  to?: string;
  log?: Logger;
} = {}): Promise<RollupResult> {
  const from = options.from ?? sqlDaysAgo(7);
  const to = options.to ?? sqlDaysAgo(0);

  const result = await db.execute<{ keyword_target_id: string }>(sql`
    INSERT INTO daily_rank_rollups (
      keyword_target_id, day,
      best_rank_group, worst_rank_group, avg_rank_group,
      best_rank_absolute, avg_rank_absolute,
      checks_count, found_count
    )
    SELECT
      serp_checks.keyword_target_id,
      ${ROLLUP_DAY} AS day,
      MIN(serp_checks.rank_group)                        AS best_rank_group,
      MAX(serp_checks.rank_group)                        AS worst_rank_group,
      ROUND(AVG(serp_checks.rank_group)::numeric, 2)     AS avg_rank_group,
      MIN(serp_checks.rank_absolute)                     AS best_rank_absolute,
      ROUND(AVG(serp_checks.rank_absolute)::numeric, 2)  AS avg_rank_absolute,
      COUNT(*)::int                                      AS checks_count,
      COUNT(*) FILTER (WHERE serp_checks.found)::int     AS found_count
    FROM serp_checks
    JOIN properties ON properties.id = serp_checks.property_id
    WHERE ${ROLLUP_DAY} BETWEEN ${from}::date AND ${to}::date
    GROUP BY serp_checks.keyword_target_id, ${ROLLUP_DAY}
    ON CONFLICT (keyword_target_id, day) DO UPDATE SET
      best_rank_group    = excluded.best_rank_group,
      worst_rank_group   = excluded.worst_rank_group,
      avg_rank_group     = excluded.avg_rank_group,
      best_rank_absolute = excluded.best_rank_absolute,
      avg_rank_absolute  = excluded.avg_rank_absolute,
      checks_count       = excluded.checks_count,
      found_count        = excluded.found_count
    RETURNING keyword_target_id
  `);

  return { daysWritten: result.rows.length, from, to };
}

/** `YYYY-MM-DD` for N days ago, computed in UTC. Window bounds only. */
function sqlDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

/** The cron entry point: wraps the rollup in an `ingest_runs` row. */
export async function runRollupJob(options: { from?: string; to?: string } = {}) {
  const outcome = await withIngestRun({ kind: 'rollup' }, async (run) => {
    const result = await buildDailyRollups({ ...options, log: run.log });

    run.addRows(result.daysWritten);
    run.setMeta({ from: result.from, to: result.to, rows_written: result.daysWritten });
    run.log.info('rollups rebuilt', {
      from: result.from,
      to: result.to,
      rows_written: result.daysWritten,
    });

    return result;
  });

  return outcome.result;
}
