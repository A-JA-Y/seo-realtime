import { sql } from 'drizzle-orm';

import { db } from '@/server/db';
import { withIngestRun } from '@/server/ingest/runs';
import { pruneRateLimits } from '@/server/api/rate-limit';
import { buildDailyRollups } from './rollups';

/**
 * Retention (§6).
 *
 * "Daily. Delete serp_payloads older than 30 days. Roll serp_checks older than
 * 14 days into daily_rank_rollups, then delete the per-check rows older than 90
 * days. Neon's free tier gives 0.5 GB per project; without this the table
 * outgrows it within a year."
 *
 * The ORDER matters more than the thresholds. Deleting before rolling up
 * destroys the only copy of the data, and the loss is silent — the chart simply
 * has no points for that period and nothing says why.
 */

/** §6. Raw payloads are the bulk of the storage and nothing reads them after a month. */
export const PAYLOAD_RETENTION_DAYS = 30;

/** §6. Per-check rows survive three months; rollups carry the series beyond that. */
export const CHECK_RETENTION_DAYS = 90;

/**
 * Checks older than this are guaranteed to be in a rollup before any deletion.
 * Well inside the 90-day cut, so there is a 76-day margin for a failed run.
 */
export const ROLLUP_LAG_DAYS = 14;

/**
 * Hourly Search Console rows are dropped once the day has a settled figure.
 *
 * Reconciliation writes a `final` row at T−4, and `getGscSeries` resolves
 * final > fresh > hourly, so after that the hourly buckets only carry intra-day
 * detail. 30 days is generous: it keeps the "how much did Google revise this"
 * comparison available for a month.
 */
export const GSC_HOURLY_RETENTION_DAYS = 30;

export interface PruneResult {
  payloadsDeleted: number;
  checksDeleted: number;
  gscHourlyDeleted: number;
  rateLimitsDeleted: number;
  rollupsWritten: number;
}

export async function pruneSerpPayloads(days = PAYLOAD_RETENTION_DAYS): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM serp_payloads
    WHERE created_at < now() - (${days} * interval '1 day')
    RETURNING id
  `);
  return result.rows.length;
}

/**
 * Delete per-check rows past the retention window.
 *
 * Refuses to delete anything for a day that has no rollup. That guard is the
 * whole safety property: if the rollup job has been failing silently for a
 * fortnight, this would otherwise quietly delete the only remaining copy of
 * three months of rank history.
 */
export async function pruneSerpChecks(days = CHECK_RETENTION_DAYS): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM serp_checks
    WHERE checked_at < now() - (${days} * interval '1 day')
      AND EXISTS (
        SELECT 1 FROM daily_rank_rollups r
        JOIN properties p ON p.id = serp_checks.property_id
        WHERE r.keyword_target_id = serp_checks.keyword_target_id
          AND r.day = (serp_checks.checked_at AT TIME ZONE p.timezone)::date
      )
    RETURNING id
  `);
  return result.rows.length;
}

/**
 * Delete hourly GSC rows for dates that already have a settled daily figure.
 *
 * The `EXISTS` clause is not an optimisation. Without it, a date whose
 * reconciliation never ran — a property added mid-window, a run that failed —
 * would lose its hourly rows and be left with nothing at all, rendering as a
 * permanent gap that looks like "no impressions".
 */
export async function pruneGscHourly(days = GSC_HOURLY_RETENTION_DAYS): Promise<number> {
  const result = await db.execute(sql`
    DELETE FROM gsc_snapshots
    WHERE data_state = 'hourly'
      -- The interval form, not current_date minus a bound parameter: such a
      -- parameter is of unknown type and Postgres cannot resolve date-minus-unknown.
      AND gsc_date < (now() - (${days} * interval '1 day'))::date
      AND EXISTS (
        SELECT 1 FROM gsc_snapshots settled
        WHERE settled.keyword_id = gsc_snapshots.keyword_id
          AND settled.gsc_date   = gsc_snapshots.gsc_date
          AND settled.data_state = 'final'
      )
    RETURNING id
  `);
  return result.rows.length;
}

/**
 * The cron entry point.
 *
 * Rolls up first, then prunes. Each step is independent so one failure does not
 * abort the rest (§7), and a failed rollup leaves the corresponding checks
 * undeleted rather than taking them with it.
 */
export async function runPruneJob(): Promise<PruneResult> {
  const outcome = await withIngestRun({ kind: 'prune' }, async (run) => {
    const result: PruneResult = {
      payloadsDeleted: 0,
      checksDeleted: 0,
      gscHourlyDeleted: 0,
      rateLimitsDeleted: 0,
      rollupsWritten: 0,
    };

    /*
     * 1. Make sure everything about to be deleted is represented in a rollup.
     *
     * There is deliberately NO lower bound. Any bound creates a window of rows
     * that are too old to be rolled up and therefore — because pruneSerpChecks
     * refuses to delete an unrolled day — can never be deleted either. They
     * would accumulate forever, which is the opposite of what this job is for.
     *
     * Unbounded is cheap: in steady state serp_checks holds at most
     * CHECK_RETENTION_DAYS of rows, and the query is a single grouped scan.
     */
    try {
      const rolled = await buildDailyRollups({
        from: EPOCH,
        to: daysAgo(ROLLUP_LAG_DAYS),
      });
      result.rollupsWritten = rolled.daysWritten;
    } catch (error) {
      // Without rollups, pruneSerpChecks deletes nothing (its EXISTS guard
      // sees to that), so stopping here loses no data — it only defers.
      run.markFailed(`rollup before prune failed: ${String(error)}`);
      run.log.error('skipping check pruning because the rollup failed');
      return result;
    }

    for (const step of [
      { name: 'serp_payloads', run: () => pruneSerpPayloads() },
      { name: 'serp_checks', run: () => pruneSerpChecks() },
      { name: 'gsc_hourly', run: () => pruneGscHourly() },
      /*
       * Rate-limit windows. Tiny, but unbounded without this: one row per
       * (principal, bucket) that is never revisited stays for ever, and the
       * anonymous bucket collects one per key for every caller that ever
       * knocked.
       */
      { name: 'api_rate_limits', run: () => pruneRateLimits() },
    ] as const) {
      try {
        const deleted = await step.run();
        if (step.name === 'serp_payloads') result.payloadsDeleted = deleted;
        else if (step.name === 'serp_checks') result.checksDeleted = deleted;
        else if (step.name === 'gsc_hourly') result.gscHourlyDeleted = deleted;
        else result.rateLimitsDeleted = deleted;
      } catch (error) {
        run.markPartial(`${step.name}: ${String(error)}`);
        run.log.error('prune step failed', { step: step.name });
      }
    }

    run.addRows(
      result.payloadsDeleted +
        result.checksDeleted +
        result.gscHourlyDeleted +
        result.rateLimitsDeleted,
    );
    run.setMeta({ ...result });
    run.log.info('retention complete', { ...result });

    return result;
  });

  return outcome.result;
}

/** Earlier than any plausible check, so the pre-prune rollup has no hole. */
const EPOCH = '1970-01-01';

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}
