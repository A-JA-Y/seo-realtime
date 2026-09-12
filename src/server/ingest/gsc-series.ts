import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';

import {
  GSC_TIMEZONE,
  dateRange,
  shiftDate,
  type DateString,
} from '@/lib/gsc-dates';
import type { GscDataState } from '@/server/db/schema';

/**
 * Search Console read resolution — the ONE place precedence lives (§5).
 *
 * "Expose getGscSeries(keywordId, from, to) that returns one row per date,
 *  choosing final where it exists, else fresh, else the impression-weighted
 *  aggregate of that date's hourly rows. The resolution order must live in
 *  exactly one function so no caller can get it wrong."
 *
 * The resolution itself is a PURE function over rows (`resolveGscSeries`), with
 * the database query as a thin shell around it. That split is not stylistic:
 * §13 requires the precedence and aggregation tests to run with no database,
 * and precedence expressed in SQL cannot be tested from a fixture.
 */

/** Domain rule 6: "fewer than 3 impressions" is noise. Three is not fewer than three. */
export const LOW_CONFIDENCE_IMPRESSIONS = 3;

/** Precedence, most authoritative first. Resolution is by STATE, never by which row has a value. */
const PRECEDENCE = ['final', 'fresh', 'hourly'] as const;

export type GscSource = GscDataState | 'none';

/* ══════════════════════════════════════════════════════════════════════════
   Input
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * A row as it crosses the driver.
 *
 * `position` and `ctr` are declared `string | number | null` because Postgres
 * `numeric` arrives as a STRING through both node-postgres and the Neon HTTP
 * driver. Verified, not assumed: reading `position` straight off a row and
 * adding 1 yields `"13.401"`, a silent string concatenation. Parsing happens
 * exactly once, in `toNumber`, and nothing downstream ever sees the string.
 */
export interface GscSnapshotRow {
  gscDate: DateString;
  gscHour: number | null;
  dataState: GscDataState;
  clicks: number;
  impressions: number;
  ctr: string | number | null;
  position: string | number | null;
}

/* ══════════════════════════════════════════════════════════════════════════
   Output
   ══════════════════════════════════════════════════════════════════════════ */

/** A reading from one data state. */
export interface GscCandidate {
  source: GscDataState;
  position: number | null;
  clicks: number;
  impressions: number;
  ctr: number | null;
  /** Impressions actually behind `position` — see GscSeriesPoint. */
  positionImpressions: number;
}

export interface GscHourCoverage {
  /** Hourly buckets Google returned for this date. */
  hoursWithData: number;
  /**
   * Distinct hour LABELS the Pacific day has: 23 on spring-forward, 24
   * otherwise — including the 25-hour fall-back day, where two real hours share
   * label 1. `gsc_hour` is a 0-23 label, not an elapsed hour.
   */
  hoursInDay: number;
}

export interface GscSeriesPoint {
  date: DateString;
  /** Which state won. 'none' means we hold no row at all for this date. */
  source: GscSource;
  /**
   * Null means "no position", never zero. Either we hold nothing (`source:
   * 'none'`), or the row had no impressions so Google reported no position.
   * Acceptance criterion 3 depends on the chart seeing null and drawing a gap.
   */
  position: number | null;
  /** Null only when `source` is 'none'. A measured zero is 0, not null. */
  clicks: number | null;
  impressions: number | null;
  /** Recomputed as clicks/impressions. Null when there were no impressions. */
  ctr: number | null;
  /**
   * The impressions actually behind `position`.
   *
   * For a daily row this equals `impressions`. For an hourly aggregate it is
   * the sum over only the hours that HAD a position, which can be smaller. §11
   * requires the tooltip to show "the impression count behind the average", and
   * that is this number, not the day's total.
   */
  positionImpressions: number;
  /** True for anything Google may still revise — i.e. not `final`. */
  isProvisional: boolean;
  /** Domain rule 6. Excluded from alerts, flagged in the UI. */
  isLowConfidence: boolean;
  /** Non-null only when the winning source is 'hourly'. */
  hourCoverage: GscHourCoverage | null;
  /**
   * Lower-precedence readings we still hold for this date, in precedence order.
   *
   * Acceptance criterion 10: "Provisional hourly values are visibly replaced by
   * finalised values after reconciliation, and the earlier provisional value
   * remains queryable." This is what makes the revision visible without a
   * second query — how far Google moved a number is how you calibrate trust in
   * same-day figures.
   */
  provisional: GscCandidate[];
}

/* ══════════════════════════════════════════════════════════════════════════
   Numeric parsing — exactly one site
   ══════════════════════════════════════════════════════════════════════════ */

export class GscSeriesDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GscSeriesDataError';
  }
}

/**
 * Parse a numeric column value.
 *
 * Throws rather than returning NaN. A NaN that escapes here propagates into
 * every average downstream and renders as a blank chart with no explanation —
 * far harder to diagnose than a loud failure at the boundary.
 */
export function toNumber(value: string | number | null | undefined, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new GscSeriesDataError(`${field} is not finite: ${value}`);
    return value;
  }

  const trimmed = value.trim();
  if (trimmed === '') throw new GscSeriesDataError(`${field} is an empty string`);

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) throw new GscSeriesDataError(`${field} is not numeric: ${value}`);
  return parsed;
}

/** Round to the 2 decimal places `numeric(6,2)` stores. */
const round2 = (n: number) => Math.round(n * 100) / 100;
/** Round to the 6 decimal places `numeric(7,6)` stores. */
const round6 = (n: number) => Math.round(n * 1_000_000) / 1_000_000;

/**
 * CTR is always recomputed from clicks and impressions, never read from the
 * stored column and never averaged across hours.
 *
 * A mean of ratios is not the ratio of sums: three hours at 0%, 0% and 100% CTR
 * average to 33%, while the day might have had 1 click in 300 impressions.
 * Summing is worse still — it can exceed 1.
 */
function computeCtr(clicks: number, impressions: number): number | null {
  if (impressions <= 0) return null;
  return round6(clicks / impressions);
}

/* ══════════════════════════════════════════════════════════════════════════
   Pacific day length, in hour LABELS
   ══════════════════════════════════════════════════════════════════════════ */

const hoursInDayCache = new Map<DateString, number>();

/**
 * How many distinct `gsc_hour` labels a Pacific date has.
 *
 * Verified against date-fns-tz rather than reasoned about:
 *   2026-03-08  23 elapsed hours, 23 labels (02:00 never happens)
 *   2026-06-15  24 elapsed hours, 24 labels
 *   2026-11-01  25 elapsed hours, 24 labels (01:00 happens twice)
 *
 * The fall-back day is the trap. It is 25 hours long, but `gsc_hour` is a
 * SMALLINT 0-23 — a clock label, not an elapsed hour — so it still has only 24
 * distinct values. Treating it as 25 would make every fall-back day render as
 * permanently incomplete.
 */
export function pacificHourLabelsInDay(date: DateString): number {
  const cached = hoursInDayCache.get(date);
  if (cached !== undefined) return cached;

  let count = 0;
  for (let hour = 0; hour < 24; hour++) {
    const instant = fromZonedTime(`${date} ${String(hour).padStart(2, '0')}:00:00`, GSC_TIMEZONE);
    // A nonexistent local time is shifted forward by the library, so it fails
    // to round-trip. That is how the missing spring-forward hour is detected.
    if (Number(formatInTimeZone(instant, GSC_TIMEZONE, 'H')) === hour) count++;
  }

  hoursInDayCache.set(date, count);
  return count;
}

/* ══════════════════════════════════════════════════════════════════════════
   Aggregation
   ══════════════════════════════════════════════════════════════════════════ */

/** A daily row (final or fresh) becomes a candidate directly. */
function dailyCandidate(row: GscSnapshotRow): GscCandidate {
  const impressions = row.impressions;
  const clicks = row.clicks;
  const position = toNumber(row.position, 'position');

  // The storage invariant is enforced by a CHECK constraint, but the read path
  // does not depend on the constraint being there: no impressions means no
  // position, whatever happens to be stored.
  const effectivePosition = impressions > 0 ? position : null;

  return {
    source: row.dataState,
    position: effectivePosition === null ? null : round2(effectivePosition),
    clicks,
    impressions,
    ctr: computeCtr(clicks, impressions),
    positionImpressions: effectivePosition === null ? 0 : impressions,
  };
}

/**
 * Collapse a date's hourly rows into one impression-weighted reading.
 *
 *     position = Σ(position_h × impressions_h) / Σ(impressions_h)
 *
 * over only the hours that have BOTH a position and impressions > 0. The
 * denominator is restricted to the same set — dividing by the day's total
 * impressions instead would drag the average toward zero in proportion to how
 * many hours had no position, which is a wrong number that looks like an
 * improvement.
 *
 * Weighting matters: an hour with 1 impression at position 3 and an hour with
 * 200 impressions at position 20 is not a day at position 11.5.
 */
export function aggregateHourlyRows(rows: readonly GscSnapshotRow[]): GscCandidate {
  let clicks = 0;
  let impressions = 0;
  let weightedHundredths = 0;
  let positionImpressions = 0;

  // Sort by hour so floating-point accumulation is deterministic regardless of
  // the order the driver happened to return rows in.
  const ordered = [...rows].sort((a, b) => (a.gscHour ?? 0) - (b.gscHour ?? 0));

  for (const row of ordered) {
    clicks += row.clicks;
    impressions += row.impressions;

    const position = toNumber(row.position, 'position');
    if (position === null || row.impressions <= 0) continue;

    // Accumulate in integer hundredths — the grid numeric(6,2) stores — so the
    // sum does not drift before the single division.
    weightedHundredths += Math.round(position * 100) * row.impressions;
    positionImpressions += row.impressions;
  }

  return {
    source: 'hourly',
    position: positionImpressions > 0 ? round2(weightedHundredths / positionImpressions / 100) : null,
    clicks,
    impressions,
    ctr: computeCtr(clicks, impressions),
    positionImpressions,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   Resolution
   ══════════════════════════════════════════════════════════════════════════ */

export interface ResolveOptions {
  from: DateString;
  to: DateString;
}

const MAX_SERIES_DAYS = 1000;

function assertDateString(value: string, label: string): asserts value is DateString {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new GscSeriesDataError(
      `${label} must be a YYYY-MM-DD Pacific date string, got: ${JSON.stringify(value)}`,
    );
  }
}

/**
 * Resolve raw snapshot rows into one point per date. Pure.
 *
 * The result is DENSE: every date in [from, to] appears, including dates with
 * no rows at all, which come back with `source: 'none'` and null metrics.
 *
 * Returning a sparse array would push the gap-filling into every chart, and the
 * failure mode of getting that wrong is exactly the one acceptance criterion 3
 * forbids — a missing date silently rendering as a connected line, or as zero,
 * which on an inverted rank axis reads as "position 0", better than first place.
 */
export function resolveGscSeries(
  rows: readonly GscSnapshotRow[],
  options: ResolveOptions,
): GscSeriesPoint[] {
  const { from, to } = options;
  assertDateString(from, 'from');
  assertDateString(to, 'to');

  if (from > to) {
    throw new GscSeriesDataError(`from (${from}) must not be after to (${to})`);
  }

  const dates = dateRange(from, to);
  if (dates.length > MAX_SERIES_DAYS) {
    throw new GscSeriesDataError(`Range of ${dates.length} days exceeds the ${MAX_SERIES_DAYS}-day limit`);
  }

  // Bucket by date, then by state. Hourly rows accumulate; daily rows are
  // unique per (date, state) under the natural key.
  const byDate = new Map<DateString, { daily: Map<GscDataState, GscSnapshotRow>; hourly: GscSnapshotRow[] }>();

  for (const row of rows) {
    if (row.gscDate < from || row.gscDate > to) continue;

    let bucket = byDate.get(row.gscDate);
    if (!bucket) {
      bucket = { daily: new Map(), hourly: [] };
      byDate.set(row.gscDate, bucket);
    }

    // A row's shape must agree with its state. The CHECK constraints make the
    // disagreeing cases unstorable; this keeps the resolver total anyway, so a
    // hand-built fixture cannot produce a nonsense average.
    if (row.dataState === 'hourly') {
      if (row.gscHour === null) continue;
      bucket.hourly.push(row);
    } else {
      if (row.gscHour !== null) continue;
      bucket.daily.set(row.dataState, row);
    }
  }

  return dates.map((date) => {
    const bucket = byDate.get(date);

    const candidates: GscCandidate[] = [];
    for (const state of PRECEDENCE) {
      if (!bucket) break;
      if (state === 'hourly') {
        if (bucket.hourly.length > 0) candidates.push(aggregateHourlyRows(bucket.hourly));
      } else {
        const row = bucket.daily.get(state);
        if (row) candidates.push(dailyCandidate(row));
      }
    }

    const winner = candidates[0];

    if (!winner) {
      return {
        date,
        source: 'none',
        position: null,
        clicks: null,
        impressions: null,
        ctr: null,
        positionImpressions: 0,
        isProvisional: false,
        isLowConfidence: true,
        hourCoverage: null,
        provisional: [],
      };
    }

    return {
      date,
      source: winner.source,
      position: winner.position,
      clicks: winner.clicks,
      impressions: winner.impressions,
      ctr: winner.ctr,
      positionImpressions: winner.positionImpressions,
      isProvisional: winner.source !== 'final',
      isLowConfidence: winner.positionImpressions < LOW_CONFIDENCE_IMPRESSIONS,
      hourCoverage:
        winner.source === 'hourly' && bucket
          ? { hoursWithData: bucket.hourly.length, hoursInDay: pacificHourLabelsInDay(date) }
          : null,
      provisional: candidates.slice(1),
    };
  });
}

/**
 * Domain rule 6: a position standing on fewer than 3 impressions must not drive
 * an alert. Exported so the alert engine imports the rule rather than
 * re-deriving the threshold.
 */
export function isAlertEligible(point: GscSeriesPoint): boolean {
  return point.position !== null && !point.isLowConfidence;
}

/** Convenience for callers that want yesterday-relative windows. */
export function seriesWindow(end: DateString, days: number): ResolveOptions {
  return { from: shiftDate(end, -(days - 1)), to: end };
}
