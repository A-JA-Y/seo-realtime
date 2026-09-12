import { and, eq, isNull } from 'drizzle-orm';

import { settleWithConcurrency } from '@/lib/concurrency';
import {
  RECONCILE_LAG_DAYS,
  pacificDate,
  reconcileTargetDate,
  shiftDate,
  type DateString,
} from '@/lib/gsc-dates';
import type { Logger } from '@/lib/logger';
import { redactError } from '@/lib/redact';
import { httpStatusOf } from '@/lib/retry';
import { db } from '@/server/db';
import {
  gscBackfillCursors,
  keywords,
  properties,
  type GscDimensionMode,
  type Keyword,
  type Property,
} from '@/server/db/schema';
import {
  GSC_ROW_LIMIT,
  createGscClient,
  exactQueryFilter,
  type GscClient,
  type GscDataStateParam,
  type GscDimension,
  type SearchAnalyticsQuery,
} from './gsc-client';
import { mapGscRows, upsertGscSnapshots, type MappedRow } from './gsc-upsert';
import { aggregateStatus, withIngestRun, type RunHandle } from './runs';

/**
 * The three Search Console ingest jobs (§5).
 *
 * Shared shape: one request per tracked keyword, because Google "does not
 * guarantee to return all data rows but rather top ones" — fetching everything
 * and filtering client-side silently drops whichever keywords fall outside the
 * top slice. Requests are free and the quota is 1,200/minute per site, so the
 * only reason to bound concurrency is to avoid self-inflicted throttling.
 */

/** Simultaneous requests to Google per job. Far below quota; see §12. */
const REQUEST_CONCURRENCY = 6;

/** Search Console retains 16 months. */
const BACKFILL_MONTHS = 16;

/** §5: "Walk backwards in 3-month windows." */
const BACKFILL_WINDOW_DAYS = 90;

/**
 * Wall-clock budget for one backfill invocation.
 *
 * Vercel Hobby kills a function at 60 seconds with no chance to record
 * progress, so the job stops itself at 45 and reports `partial` — a state the
 * cron dispatcher can re-enter — rather than being killed mid-window.
 */
const BACKFILL_BUDGET_MS = 45_000;

/** How long a `per_date` answer stands before the combined shape is re-probed. */
const DIMENSION_REPROBE_DAYS = 30;

export interface JobDeps {
  client?: GscClient;
  /** Injected so tests can pin "now" without faking timers globally. */
  now?: () => Date;
}

function deps(overrides: JobDeps = {}) {
  return {
    client: overrides.client ?? createGscClient(),
    now: overrides.now ?? (() => new Date()),
  };
}

async function activeKeywords(propertyId: string): Promise<Keyword[]> {
  return db
    .select()
    .from(keywords)
    .where(and(eq(keywords.propertyId, propertyId), eq(keywords.isActive, true)));
}

async function getProperty(propertyId: string): Promise<Property> {
  const [property] = await db.select().from(properties).where(eq(properties.id, propertyId));
  if (!property) throw new Error(`Property not found: ${propertyId}`);
  return property;
}

export async function activeProperties(): Promise<Property[]> {
  return db.select().from(properties).where(eq(properties.isActive, true));
}

/* ══════════════════════════════════════════════════════════════════════════
   Shared fetch + write for one keyword
   ══════════════════════════════════════════════════════════════════════════ */

interface FetchSpec {
  startDate: DateString;
  endDate: DateString;
  dimensions: GscDimension[];
  dataState: GscDataStateParam;
  /** Supplies the date when the request does not group by `date`. */
  fallbackDate?: DateString;
}

async function fetchKeywordRows(
  client: GscClient,
  property: Property,
  keyword: Keyword,
  spec: FetchSpec,
  log: Logger,
): Promise<MappedRow[]> {
  const query: SearchAnalyticsQuery = {
    startDate: spec.startDate,
    endDate: spec.endDate,
    dimensions: spec.dimensions,
    dataState: spec.dataState,
    rowLimit: GSC_ROW_LIMIT,
    dimensionFilterGroups: exactQueryFilter(keyword.term),
  };

  const response = await client.searchAnalytics(property.gscSiteUrl, query);

  if (response.rows.length >= GSC_ROW_LIMIT) {
    // One filtered keyword over a 3-month window cannot approach 25,000 rows.
    // If it ever does, the response is truncated and we are silently losing
    // data — say so rather than storing a partial answer as if complete.
    log.warn('response hit the row limit and may be truncated', {
      keyword_id: keyword.id,
      rows: response.rows.length,
      start_date: spec.startDate,
      end_date: spec.endDate,
    });
  }

  const mapped = mapGscRows(response.rows, {
    dimensions: spec.dimensions,
    ...(spec.fallbackDate === undefined ? {} : { fallbackDate: spec.fallbackDate }),
  });

  if (mapped.rejected.length > 0) {
    // §5: "Reject and log anything unexpected rather than coercing."
    log.warn('rejected rows from the Search Console response', {
      keyword_id: keyword.id,
      rejected: mapped.rejected.slice(0, 10),
      rejected_count: mapped.rejected.length,
    });
  }

  return mapped.rows;
}

/* ══════════════════════════════════════════════════════════════════════════
   Dimension probe — §5's documented fallback
   ══════════════════════════════════════════════════════════════════════════ */

export function shouldReprobe(property: Property, now: Date): boolean {
  if (property.gscDimensionMode === 'unknown') return true;
  if (property.gscDimensionMode === 'combined') return false;

  // A `per_date` answer is re-probed occasionally. Never re-probing makes a
  // downgrade permanent if Google starts accepting the combined shape; probing
  // every hour is exactly what §5 forbids.
  const probedAt = property.gscDimensionProbedAt;
  if (!probedAt) return true;
  return now.getTime() - probedAt.getTime() > DIMENSION_REPROBE_DAYS * 86_400_000;
}

async function recordDimensionMode(propertyId: string, mode: GscDimensionMode, now: Date) {
  await db
    .update(properties)
    .set({ gscDimensionMode: mode, gscDimensionProbedAt: now })
    .where(eq(properties.id, propertyId));
}

/**
 * Fetch hourly rows for one keyword, using whichever request shape works.
 *
 * Google's reference confirms `date` and `hour` are both valid dimensions but
 * does not document whether they may be combined. So: try the combined shape;
 * on a 400, fall back to one request per date with `["hour","query"]`.
 *
 * `withRetry` deliberately does not retry a 400, which is what lets the 400
 * reach here as a signal rather than being swallowed as a failure.
 */
async function fetchHourlyRows(
  client: GscClient,
  property: Property,
  keyword: Keyword,
  dates: DateString[],
  mode: GscDimensionMode,
  log: Logger,
): Promise<{ rows: MappedRow[]; observedMode: 'combined' | 'per_date'; failedDates: DateString[] }> {
  const first = dates[0] as DateString;
  const last = dates[dates.length - 1] as DateString;

  if (mode !== 'per_date') {
    try {
      const rows = await fetchKeywordRows(
        client,
        property,
        keyword,
        {
          startDate: first,
          endDate: last,
          dimensions: ['date', 'hour', 'query'],
          dataState: 'hourly_all',
        },
        log,
      );
      return { rows, observedMode: 'combined' as const, failedDates: [] as DateString[] };
    } catch (error) {
      if (httpStatusOf(error) !== 400) throw error;
      log.info('combined date+hour shape rejected with 400; falling back to one request per date', {
        keyword_id: keyword.id,
      });
    }
  }

  // Per-date fallback: one request per day, grouping by hour only. The date is
  // supplied from the request rather than the response.
  const perDate = await settleWithConcurrency(dates, REQUEST_CONCURRENCY, (date) =>
    fetchKeywordRows(
      client,
      property,
      keyword,
      {
        startDate: date,
        endDate: date,
        dimensions: ['hour', 'query'],
        dataState: 'hourly_all',
        fallbackDate: date,
      },
      log,
    ),
  );

  const failed = perDate.filter((r) => !r.ok);
  if (failed.length === dates.length) {
    throw failed[0]!.ok === false ? failed[0]!.error : new Error('all per-date requests failed');
  }

  // Dates that failed are NOT silently dropped. Returning their rows as if the
  // window were complete would store a partial day and report the run as a
  // success — the silent ingest death §12 names as the worst failure mode.
  const failedDates = perDate.flatMap((r, i) => (r.ok ? [] : [dates[i] as DateString]));

  return {
    rows: perDate.flatMap((r) => (r.ok ? r.value : [])),
    observedMode: 'per_date' as const,
    failedDates,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   Hourly job
   ══════════════════════════════════════════════════════════════════════════ */

export interface IngestResult {
  propertyId: string;
  keywordsProcessed: number;
  keywordsFailed: number;
  rowsWritten: number;
}

/**
 * Hourly near-live pull (§5).
 *
 * Covers PT today and yesterday, computed in Pacific Time — not UTC, not IST.
 * For most of the Indian working day "today" in Pacific is still yesterday, and
 * asking Google for the Indian date returns an empty row set indistinguishable
 * from a genuine zero.
 *
 * Also writes a daily `fresh` row per date from `dataState: "all"`. See
 * NOTES.md §9 — the read precedence names `fresh`, so something has to produce
 * it, and a daily figure Google computed beats one we aggregate from partial
 * hourly buckets.
 */
export async function ingestGscHourly(propertyId: string, overrides: JobDeps = {}): Promise<IngestResult> {
  const { client, now } = deps(overrides);

  const outcome = await withIngestRun({ kind: 'gsc_hourly', propertyId }, async (run) => {
    const property = await getProperty(propertyId);
    const terms = await activeKeywords(propertyId);

    const instant = now();
    // Both dates come from the injected instant, so the window, the probe
    // timestamp and the run row all describe the same moment. Deriving them
    // from the wall clock instead makes the job untestable and lets the dates
    // disagree with everything else the run records.
    const dates: DateString[] = [pacificDate(instant, -1), pacificDate(instant, 0)];

    /*
     * The `fresh` window reaches further back than the hourly one, to T-3.
     *
     * Reconciliation only settles exactly T-4, so without this, T-3 and T-2
     * have nothing but hourly rows and the chart shows OUR aggregate of
     * whatever hour buckets Google happened to return. That aggregate
     * understates impressions and biases the position toward the keyword's
     * busiest hours — and it is exempt from the domain rule 6 confidence check,
     * because rule 6 keys off the same understated impression count. A daily
     * `all` figure is one Google computed over the whole day.
     */
    const freshFrom = pacificDate(instant, -(RECONCILE_LAG_DAYS - 1));
    const freshTo = pacificDate(instant, 0);
    const reprobe = shouldReprobe(property, instant);
    const mode: GscDimensionMode = reprobe ? 'unknown' : property.gscDimensionMode;

    run.setMeta({
      dates,
      fresh_window: [freshFrom, freshTo],
      keywords: terms.length,
      dimension_mode: property.gscDimensionMode,
      reprobe,
    });
    run.log.info('hourly ingest starting', { dates, keywords: terms.length });

    const observedModes: Array<'combined' | 'per_date'> = [];
    // Rows are tallied as they are COMMITTED, not returned at the end. A
    // keyword whose second request fails has still written its first request's
    // rows, and reporting rows_written as 0 for it would understate the run.
    const tally = { rows: 0 };

    const results = await settleWithConcurrency(terms, REQUEST_CONCURRENCY, async (keyword) => {
      const hourly = await fetchHourlyRows(client, property, keyword, dates, mode, run.log);
      observedModes.push(hourly.observedMode);

      if (hourly.failedDates.length > 0) {
        run.markPartial(
          `keyword ${keyword.term}: no hourly data for ${hourly.failedDates.join(', ')}`,
        );
      }

      // `tally.rows += await f()` would read tally.rows BEFORE suspending, so
      // two concurrent keywords both read the old value and one update is lost.
      // Resolve first, then add — no await between the read and the write.
      const hourlyWritten = await upsertGscSnapshots(hourly.rows, {
        propertyId,
        keywordId: keyword.id,
        dataState: 'hourly',
      });
      tally.rows += hourlyWritten;

      // Daily-granularity provisional figures. One extra free request.
      const freshRows = await fetchKeywordRows(
        client,
        property,
        keyword,
        {
          startDate: freshFrom,
          endDate: freshTo,
          dimensions: ['date', 'query'],
          dataState: 'all',
        },
        run.log,
      );

      const freshWritten = await upsertGscSnapshots(freshRows, {
        propertyId,
        keywordId: keyword.id,
        dataState: 'fresh',
      });
      tally.rows += freshWritten;
    });

    /*
     * Cache the probe answer so the failing shape is not retried every hour.
     *
     * The property is downgraded to `per_date` only when NOT ONE keyword got
     * the combined shape to work. Taking whichever keyword happened to finish
     * first would make the answer a race, and would let a single keyword's 400
     * — which can have causes other than the dimension combination — downgrade
     * the whole property for 30 days.
     */
    const observedMode = observedModes.includes('combined')
      ? 'combined'
      : observedModes.includes('per_date')
        ? 'per_date'
        : null;

    if (observedMode && (reprobe || property.gscDimensionMode !== observedMode)) {
      await recordDimensionMode(propertyId, observedMode, instant);
      run.log.info('cached Search Console dimension mode', { dimension_mode: observedMode });
    }

    return summarise(run, propertyId, results, tally.rows);
  });

  return outcome.result;
}

/* ══════════════════════════════════════════════════════════════════════════
   Reconciliation
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Re-fetch T−4 with `dataState: "final"` and write a SEPARATE `final` row (§5).
 *
 * The provisional rows are never deleted. Keeping both is what lets the UI show
 * how far Google moved a figure, which is how you calibrate trust in same-day
 * numbers — and it is acceptance criterion 10.
 */
export async function reconcileGscFinal(
  propertyId: string,
  overrides: JobDeps = {},
): Promise<IngestResult> {
  const { client, now } = deps(overrides);

  const outcome = await withIngestRun({ kind: 'gsc_reconcile', propertyId }, async (run) => {
    const property = await getProperty(propertyId);
    const terms = await activeKeywords(propertyId);
    const target = reconcileTargetDate(now());

    run.setMeta({ target_date: target, lag_days: RECONCILE_LAG_DAYS, keywords: terms.length });
    run.log.info('reconciling', { target_date: target, keywords: terms.length });

    const tally = { rows: 0 };

    const results = await settleWithConcurrency(terms, REQUEST_CONCURRENCY, async (keyword) => {
      const rows = await fetchKeywordRows(
        client,
        property,
        keyword,
        {
          startDate: target,
          endDate: target,
          dimensions: ['date', 'query'],
          dataState: 'final',
          fallbackDate: target,
        },
        run.log,
      );

      const written = await upsertGscSnapshots(rows, {
        propertyId,
        keywordId: keyword.id,
        dataState: 'final',
      });
      tally.rows += written;
    });

    return summarise(run, propertyId, results, tally.rows);
  });

  return outcome.result;
}

/* ══════════════════════════════════════════════════════════════════════════
   Backfill
   ══════════════════════════════════════════════════════════════════════════ */

export interface BackfillResult extends IngestResult {
  complete: boolean;
  windowsProcessed: number;
  keywordsRemaining: number;
}

/** The oldest date Search Console still holds, as a Pacific date. */
export function backfillFloor(today: DateString): DateString {
  const [year = '1970', month = '01', day = '01'] = today.split('-');
  const anchor = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  anchor.setUTCMonth(anchor.getUTCMonth() - BACKFILL_MONTHS);
  return anchor.toISOString().slice(0, 10) as DateString;
}

/**
 * Walk one keyword's history backwards by one 3-month window.
 *
 * Returns the new `coveredFrom`, or null when the keyword has reached the
 * retention floor.
 */
function nextWindow(
  cursor: { coveredFrom: DateString | null; coveredThrough: DateString | null },
  today: DateString,
  floor: DateString,
): { startDate: DateString; endDate: DateString } | null {
  // First run starts at yesterday — today is still accumulating and would be
  // re-fetched as `final` by reconciliation anyway.
  const end = cursor.coveredFrom ? shiftDate(cursor.coveredFrom, -1) : shiftDate(today, -1);
  if (end < floor) return null;

  const start = shiftDate(end, -(BACKFILL_WINDOW_DAYS - 1));
  return { startDate: start < floor ? floor : start, endDate: end };
}

/**
 * Resumable 16-month backfill (§5).
 *
 * Progress lives in `gsc_backfill_cursors`, per keyword. It cannot be derived
 * from `gsc_snapshots`: that table records only POSITIVE observations, and
 * Google omits dates with no impressions entirely, so a quiet window writes no
 * rows and `MIN(gsc_date)` never advances. Per keyword rather than per property
 * because a keyword added to an already-backfilled property still needs its own
 * history.
 *
 * Bounded by a wall-clock budget so a Hobby function is never killed
 * mid-window. An unfinished run returns `complete: false` and is re-entered by
 * the cron dispatcher.
 */
export async function backfillGsc(
  propertyId: string,
  overrides: JobDeps & { budgetMs?: number; deadline?: number } = {},
): Promise<BackfillResult> {
  const { client, now } = deps(overrides);
  /*
   * An ABSOLUTE deadline, not a per-property budget.
   *
   * The budget bounds one serverless INVOCATION, and an invocation may cover
   * several properties. Giving each property its own 45 seconds means ten
   * properties ask for 450 and the function is killed at 60 — the exact
   * mid-window kill the budget exists to prevent. A caller running several
   * properties passes one deadline for all of them.
   */
  const deadline = overrides.deadline ?? Date.now() + (overrides.budgetMs ?? BACKFILL_BUDGET_MS);
  const outOfTime = () => Date.now() >= deadline;

  const outcome = await withIngestRun({ kind: 'gsc_backfill', propertyId }, async (run) => {
    const property = await getProperty(propertyId);
    const terms = await activeKeywords(propertyId);
    const today = pacificDate(now(), 0);
    const floor = backfillFloor(today);

    run.setMeta({ floor, months: BACKFILL_MONTHS, keywords: terms.length });
    run.log.info('backfill starting', { floor, keywords: terms.length });

    if (terms.length === 0) {
      // Nothing to backfill, and nothing to claim. Stamping backfilled_at here
      // would assert that 16 months of history exists for a property that has
      // no keywords — and the stamp is write-once, so it could never be
      // corrected once keywords were added.
      run.log.info('no active keywords; nothing to backfill');
      return {
        propertyId,
        keywordsProcessed: 0,
        keywordsFailed: 0,
        rowsWritten: 0,
        complete: false,
        windowsProcessed: 0,
        keywordsRemaining: 0,
      };
    }

    const activeIds = new Set(terms.map((k) => k.id));

    await db
      .insert(gscBackfillCursors)
      .values(terms.map((k) => ({ keywordId: k.id, propertyId })))
      .onConflictDoNothing();

    let windowsProcessed = 0;
    let rowsWritten = 0;
    let failures = 0;
    /** Distinct keywords touched, so keywordsProcessed means what it says. */
    const attemptedKeywords = new Set<string>();

    /*
     * Keywords that errored in THIS invocation are set aside for the rest of it.
     *
     * A failing window does not advance its cursor — deliberately, so the work
     * is retried — but without this, the outer loop picks the same keyword up
     * again immediately and retries the same window at full speed until the
     * budget runs out. That is a hot loop against Google, wrapped in a retry
     * policy, hammering an endpoint that has already said no. The next
     * invocation starts with a clean slate and tries again.
     */
    const sidelined = new Set<string>();

    // Round-robin across keywords so an interrupted run leaves them at a
    // similar depth rather than one keyword fully done and twelve untouched.
    for (;;) {
      if (outOfTime()) {
        run.log.info('backfill budget exhausted; will resume on the next invocation', {
          windows_processed: windowsProcessed,
        });
        break;
      }

      const pending = (
        await db
          .select()
          .from(gscBackfillCursors)
          .where(
            and(
              eq(gscBackfillCursors.propertyId, propertyId),
              isNull(gscBackfillCursors.completedAt),
            ),
          )
      ).filter((c) => activeIds.has(c.keywordId) && !sidelined.has(c.keywordId));

      if (pending.length === 0) break;

      let didWork = false;

      for (const cursor of pending) {
        if (outOfTime()) break;

        const keyword = terms.find((k) => k.id === cursor.keywordId);
        if (!keyword) continue;

        const window = nextWindow(
          {
            coveredFrom: (cursor.coveredFrom as DateString | null) ?? null,
            coveredThrough: (cursor.coveredThrough as DateString | null) ?? null,
          },
          today,
          floor,
        );

        if (!window) {
          await db
            .update(gscBackfillCursors)
            .set({ completedAt: now(), updatedAt: now() })
            .where(eq(gscBackfillCursors.keywordId, cursor.keywordId));
          continue;
        }

        didWork = true;
        attemptedKeywords.add(keyword.id);

        try {
          const rows = await fetchKeywordRows(
            client,
            property,
            keyword,
            {
              startDate: window.startDate,
              endDate: window.endDate,
              dimensions: ['date', 'query'],
              dataState: 'final',
            },
            run.log,
          );

          const written = await upsertGscSnapshots(rows, {
            propertyId,
            keywordId: keyword.id,
            dataState: 'final',
          });
          rowsWritten += written;

          // Advance only after the window's rows are committed. A crash before
          // this point re-does the window, which is free: the writes are
          // idempotent. A crash after it would have skipped the window.
          await db
            .update(gscBackfillCursors)
            .set({
              coveredFrom: window.startDate,
              coveredThrough: cursor.coveredThrough ?? window.endDate,
              updatedAt: now(),
              ...(window.startDate <= floor ? { completedAt: now() } : {}),
            })
            .where(eq(gscBackfillCursors.keywordId, cursor.keywordId));

          windowsProcessed++;
        } catch (error) {
          failures++;
          sidelined.add(keyword.id);
          run.markPartial(`keyword ${keyword.term}: ${redactError(error)}`);
          run.log.error('backfill window failed; skipping this keyword until the next run', {
            keyword_id: keyword.id,
            start_date: window.startDate,
            end_date: window.endDate,
            error: redactError(error),
          });
        }
      }

      if (!didWork) break;
    }

    /*
     * Only ACTIVE keywords count toward "remaining".
     *
     * A deactivated keyword keeps its open cursor — deactivation is reversible
     * and marking it complete would be a lie — but counting it would leave the
     * property permanently incomplete, and every future invocation would
     * re-select it, find no matching keyword, do nothing, and exit.
     */
    const openCursors = await db
      .select({ keywordId: gscBackfillCursors.keywordId })
      .from(gscBackfillCursors)
      .where(
        and(eq(gscBackfillCursors.propertyId, propertyId), isNull(gscBackfillCursors.completedAt)),
      );

    const keywordsRemaining = openCursors.filter((c) => activeIds.has(c.keywordId)).length;
    const complete = keywordsRemaining === 0;

    // §5: "Set properties.backfilled_at on completion." Only on completion, and
    // only once — re-running a finished backfill must not move the timestamp.
    if (complete) {
      await db
        .update(properties)
        .set({ backfilledAt: now() })
        .where(and(eq(properties.id, propertyId), isNull(properties.backfilledAt)));
    }

    run.addRows(rowsWritten);
    run.setMeta({ windows_processed: windowsProcessed, keywords_remaining: keywordsRemaining, complete });

    // A run in which every attempted window failed is an outage, not a
    // degraded-but-productive run. markPartial has already been called per
    // failure; this promotes the run status so /ops shows a failure.
    if (failures > 0 && windowsProcessed === 0) {
      run.markFailed(`every backfill window failed (${failures} attempt(s))`);
    }

    return {
      propertyId,
      keywordsProcessed: attemptedKeywords.size - sidelined.size,
      keywordsFailed: sidelined.size,
      rowsWritten,
      complete,
      windowsProcessed,
      keywordsRemaining,
    };
  });

  return outcome.result;
}

/* ══════════════════════════════════════════════════════════════════════════
   Multi-property orchestration
   ══════════════════════════════════════════════════════════════════════════ */

function summarise(
  run: RunHandle,
  propertyId: string,
  results: Array<{ ok: boolean; error?: unknown }>,
  rowsWritten: number,
): IngestResult {
  const failures = results.filter((r) => !r.ok);
  const succeeded = results.length - failures.length;

  const status = aggregateStatus({ succeeded, failed: failures.length });

  for (const failure of failures) {
    const reason = redactError(failure.error);
    // An all-failed run is an outage, not a degradation. Recording it as
    // `partial` would show a warning on /ops where it should show a failure.
    if (status === 'failed') run.markFailed(reason);
    else run.markPartial(reason);
  }

  run.addRows(rowsWritten);

  return {
    propertyId,
    keywordsProcessed: succeeded,
    keywordsFailed: failures.length,
    rowsWritten,
  };
}

/**
 * Run a per-property job across every active property.
 *
 * §7/§12: "Never let one property's failure abort a multi-property job." Each
 * property is caught independently and the caller reports `partial`.
 */
export async function forEachActiveProperty<T>(
  job: (propertyId: string) => Promise<T>,
): Promise<{ succeeded: T[]; failed: Array<{ propertyId: string; error: string }> }> {
  const all = await activeProperties();

  const results = await settleWithConcurrency(all, 1, (property) => job(property.id));

  const succeeded: T[] = [];
  const failed: Array<{ propertyId: string; error: string }> = [];

  results.forEach((result, index) => {
    const property = all[index];
    if (!property) return;
    if (result.ok) succeeded.push(result.value);
    else failed.push({ propertyId: property.id, error: redactError(result.error) });
  });

  return { succeeded, failed };
}
