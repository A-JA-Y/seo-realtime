import { and, asc, between, eq, inArray } from 'drizzle-orm';

import type { DateString } from '@/lib/gsc-dates';
import { db } from '@/server/db';
import { gscSnapshots } from '@/server/db/schema';
import {
  resolveGscSeries,
  type GscSeriesPoint,
  type GscSnapshotRow,
} from './gsc-series';

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
): Promise<GscSeriesPoint[]> {
  const rows = await db
    .select({
      gscDate: gscSnapshots.gscDate,
      gscHour: gscSnapshots.gscHour,
      dataState: gscSnapshots.dataState,
      clicks: gscSnapshots.clicks,
      impressions: gscSnapshots.impressions,
      ctr: gscSnapshots.ctr,
      position: gscSnapshots.position,
    })
    .from(gscSnapshots)
    .where(and(eq(gscSnapshots.keywordId, keywordId), between(gscSnapshots.gscDate, from, to)))
    .orderBy(asc(gscSnapshots.gscDate));

  return resolveGscSeries(rows satisfies GscSnapshotRow[], { from, to });
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
): Promise<Map<string, GscSeriesPoint[]>> {
  const series = new Map<string, GscSeriesPoint[]>();
  if (keywordIds.length === 0) return series;

  const rows = await db
    .select({
      keywordId: gscSnapshots.keywordId,
      gscDate: gscSnapshots.gscDate,
      gscHour: gscSnapshots.gscHour,
      dataState: gscSnapshots.dataState,
      clicks: gscSnapshots.clicks,
      impressions: gscSnapshots.impressions,
      ctr: gscSnapshots.ctr,
      position: gscSnapshots.position,
    })
    .from(gscSnapshots)
    .where(
      and(inArray(gscSnapshots.keywordId, [...keywordIds]), between(gscSnapshots.gscDate, from, to)),
    )
    .orderBy(asc(gscSnapshots.gscDate));

  const grouped = new Map<string, GscSnapshotRow[]>();
  for (const row of rows) {
    const bucket = grouped.get(row.keywordId);
    if (bucket) bucket.push(row);
    else grouped.set(row.keywordId, [row]);
  }

  for (const keywordId of keywordIds) {
    series.set(keywordId, resolveGscSeries(grouped.get(keywordId) ?? [], { from, to }));
  }

  return series;
}

/**
 * Every stored state for one date, newest fetch first.
 *
 * Acceptance criterion 10 requires the superseded provisional value to remain
 * QUERYABLE, not merely retained. `getGscSeries` carries the immediate
 * predecessors on each point; this is the full audit trail, including the
 * individual hourly buckets behind an aggregate.
 */
export async function getGscRevisions(keywordId: string, date: DateString) {
  return db
    .select()
    .from(gscSnapshots)
    .where(and(eq(gscSnapshots.keywordId, keywordId), eq(gscSnapshots.gscDate, date)))
    .orderBy(asc(gscSnapshots.dataState), asc(gscSnapshots.gscHour));
}
