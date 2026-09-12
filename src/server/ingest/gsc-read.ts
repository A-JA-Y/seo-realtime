import { and, asc, between, desc, eq, inArray, sql } from 'drizzle-orm';

import { daysBetween, type DateString } from '@/lib/gsc-dates';
import { db } from '@/server/db';
import { gscSnapshots } from '@/server/db/schema';
import {
  GscSeriesDataError,
  resolveGscSeries,
  type GscSeriesPoint,
  type GscSnapshotRow,
} from './gsc-series';

/**
 * `gsc_date` is projected through `to_char`, never selected as the column.
 *
 * Both drivers DO return this column as a 'YYYY-MM-DD' string today — measured
 * against a live Postgres, not assumed. The Neon HTTP driver registers
 * `setTypeParser(DATE, (val) => val)` in `neon-http/driver.js`, and drizzle's
 * node-postgres session installs an equivalent per-query `getTypeParser` in
 * `node-postgres/session.js`. So this projection changes nothing today.
 *
 * It is here because that behaviour is a library implementation detail that the
 * type system cannot check. `PgDateString` declares no `mapFromDriverValue`, so
 * it passes the driver's value through while TYPING it `string` — if a future
 * version dropped the session parser, pg-types' default for OID 1082 would hand
 * back a JS Date under a `string` type and `tsc` would see nothing wrong.
 *
 * The failure that would follow is silent and total: a Date compares false
 * against BOTH range bounds (relational comparison takes the number hint, and
 * Number('2026-09-01') is NaN), so the row survives the window filter, then
 * buckets under an object key no date string can retrieve. Every point resolves
 * to `source: 'none'` and a keyword with finalised data renders as an empty
 * chart, with no error anywhere.
 *
 * Casting in SQL removes the dependence rather than compensating for it, and
 * costs nothing — the cast is in the SELECT list, so the index still serves the
 * range predicate. `to_char` rather than `::text` because `::text` on a date is
 * `DateStyle`-dependent. `resolveGscSeries` carries a matching runtime assertion
 * for any caller that bypasses this projection.
 */
const GSC_DATE_TEXT = sql<string>`to_char(${gscSnapshots.gscDate}, 'YYYY-MM-DD')`;

/**
 * The columns the resolver actually reads. `ctr` is deliberately absent: CTR is
 * always recomputed from clicks/impressions so the numbers a tooltip shows are
 * arithmetically consistent, and the stored column stays as the write-side
 * audit trail.
 */
const SNAPSHOT_COLUMNS = {
  gscDate: GSC_DATE_TEXT,
  gscHour: gscSnapshots.gscHour,
  dataState: gscSnapshots.dataState,
  clicks: gscSnapshots.clicks,
  impressions: gscSnapshots.impressions,
  position: gscSnapshots.position,
} as const;

/** 24 hourly + fresh + final per date, plus slack. More than this is corruption. */
const rowCap = (days: number) => days * 26 + 64;

/**
 * Refuse a truncated series rather than serving one.
 *
 * A truncated result renders as a confident, plausible, WRONG chart with no
 * indication anything was dropped. For a tool whose whole premise is honest
 * numbers, an error boundary beats a quiet lie.
 */
function assertNotTruncated(rows: readonly unknown[], cap: number, what: string): void {
  if (rows.length > cap) {
    throw new GscSeriesDataError(
      `${what} returned more than ${cap} snapshot rows; refusing to resolve a truncated series`,
    );
  }
}

/**
 * The database shell around `resolveGscSeries`.
 *
 * §5: "The resolution order must live in exactly one function so no caller can
 * get it wrong." That function is `resolveGscSeries`, and it is pure — this
 * file does one indexed range scan and hands the raw rows over.
 *
 * Keeping the precedence out of SQL is what makes §13's requirement achievable:
 * "GSC read precedence: final beats fresh beats hourly; impression-weighted
 * hourly aggregation" has to be testable from fixtures, with no database.
 */

/**
 * One keyword's resolved daily series, dense across [from, to].
 *
 * Every date in the window is present. Dates we hold no data for come back with
 * `source: 'none'` and null metrics, so a chart renders a gap rather than
 * silently connecting across the hole or plotting a zero.
 */
export async function getGscSeries(
  keywordId: string,
  from: DateString,
  to: DateString,
  options: { now?: Date } = {},
): Promise<GscSeriesPoint[]> {
  const cap = rowCap(daysBetween(from, to) + 1);

  const rows = await db
    .select(SNAPSHOT_COLUMNS)
    .from(gscSnapshots)
    .where(and(eq(gscSnapshots.keywordId, keywordId), between(gscSnapshots.gscDate, from, to)))
    .orderBy(asc(gscSnapshots.gscDate))
    .limit(cap + 1);

  assertNotTruncated(rows, cap, `getGscSeries(${keywordId}, ${from}..${to})`);

  return resolveGscSeries(rows satisfies GscSnapshotRow[], { from, to, now: options.now });
}

/**
 * The same resolution for several keywords in one round trip.
 *
 * The overview table charts every tracked keyword at once; issuing one query
 * per keyword would turn a page load into N cold Neon round trips. Resolution
 * still runs per keyword through the identical pure function — there is no
 * second implementation of the precedence rule.
 */
export async function getGscSeriesForKeywords(
  keywordIds: readonly string[],
  from: DateString,
  to: DateString,
  options: { now?: Date } = {},
): Promise<Map<string, GscSeriesPoint[]>> {
  const series = new Map<string, GscSeriesPoint[]>();
  if (keywordIds.length === 0) return series;

  const unique = [...new Set(keywordIds)];
  const cap = rowCap(daysBetween(from, to) + 1) * unique.length;

  const rows = await db
    .select({ keywordId: gscSnapshots.keywordId, ...SNAPSHOT_COLUMNS })
    .from(gscSnapshots)
    .where(
      and(inArray(gscSnapshots.keywordId, unique), between(gscSnapshots.gscDate, from, to)),
    )
    .orderBy(asc(gscSnapshots.gscDate))
    .limit(cap + 1);

  assertNotTruncated(rows, cap, `getGscSeriesForKeywords(${unique.length} keywords, ${from}..${to})`);

  const grouped = new Map<string, GscSnapshotRow[]>();
  for (const row of rows) {
    const bucket = grouped.get(row.keywordId);
    if (bucket) bucket.push(row);
    else grouped.set(row.keywordId, [row]);
  }

  for (const keywordId of unique) {
    series.set(
      keywordId,
      resolveGscSeries(grouped.get(keywordId) ?? [], { from, to, now: options.now }),
    );
  }

  return series;
}

/**
 * Every stored state for one date, most authoritative first.
 *
 * Acceptance criterion 10 requires the superseded provisional value to remain
 * QUERYABLE, not merely retained. `getGscSeries` carries the immediate
 * predecessors on each point; this is the full audit trail, including the
 * individual hourly buckets behind an aggregate.
 */
export async function getGscRevisions(keywordId: string, date: DateString) {
  // Same `to_char` projection as the series query: this function hands rows
  // straight to callers, so leaving `gsc_date` as a driver-parsed Date here
  // would reintroduce exactly the trap GSC_DATE_TEXT exists to close.
  return db
    .select({
      id: gscSnapshots.id,
      gscDate: GSC_DATE_TEXT,
      gscHour: gscSnapshots.gscHour,
      dataState: gscSnapshots.dataState,
      clicks: gscSnapshots.clicks,
      impressions: gscSnapshots.impressions,
      ctr: gscSnapshots.ctr,
      position: gscSnapshots.position,
      fetchedAt: gscSnapshots.fetchedAt,
    })
    .from(gscSnapshots)
    .where(and(eq(gscSnapshots.keywordId, keywordId), eq(gscSnapshots.gscDate, date)))
    // Precedence order — final, then fresh, then the hourly buckets by hour.
    // `data_state` is a pgEnum declared hourly/fresh/final, so DESC gives the
    // most authoritative state first, which is the order the panel reads in.
    .orderBy(desc(gscSnapshots.dataState), asc(gscSnapshots.gscHour));
}
