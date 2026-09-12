import { addDays } from 'date-fns';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';

/**
 * Pacific Time date arithmetic for Search Console.
 *
 * Domain rule 4: Search Console reports dates in Pacific Time, and those
 * strings are stored exactly as returned. Nothing in the ingest path converts
 * them. This module is the only place that computes a "GSC date", and the only
 * place that converts one for display.
 *
 * Why it matters: IST is UTC+5:30 and Pacific is UTC−7 or −8, a 12.5–13.5 hour
 * offset. For most of the IST day, "today in India" is still "yesterday in
 * Pacific". Asking for `new Date()` in IST and sending it to the API returns an
 * empty result set that looks exactly like "no impressions" — silent, and
 * indistinguishable from a real zero unless you already suspected it.
 */

export const GSC_TIMEZONE = 'America/Los_Angeles';

/** A calendar date with no time component, `YYYY-MM-DD`. */
export type DateString = string;

const DATE_FORMAT = 'yyyy-MM-dd';

/**
 * The Pacific Time calendar date for an instant, optionally shifted by whole
 * days.
 *
 * The shift is deliberately performed on a UTC-anchored calendar value rather
 * than on the instant: subtracting 24 hours across a DST boundary lands on the
 * wrong day, whereas subtracting a day from `2026-11-02` is unambiguous.
 */
export function pacificDate(instant: Date = new Date(), offsetDays = 0): DateString {
  const today = formatInTimeZone(instant, GSC_TIMEZONE, DATE_FORMAT);
  if (offsetDays === 0) return today;

  // Anchor at UTC midnight so the arithmetic is pure calendar arithmetic,
  // untouched by any timezone's DST rules.
  const anchored = new Date(`${today}T00:00:00Z`);
  return formatInTimeZone(addDays(anchored, offsetDays), 'UTC', DATE_FORMAT);
}

/** Today's date in Pacific Time. `pacificToday(-1)` is yesterday. */
export function pacificToday(offsetDays = 0): DateString {
  return pacificDate(new Date(), offsetDays);
}

/**
 * The date the reconciliation job should re-fetch as `final`.
 *
 * Search Console finalises roughly 2–3 days after the fact; T−4 gives a day of
 * margin without waiting so long that a correction goes unnoticed.
 */
export const RECONCILE_LAG_DAYS = 4;

export function reconcileTargetDate(instant: Date = new Date()): DateString {
  return pacificDate(instant, -RECONCILE_LAG_DAYS);
}

/** Shift a `YYYY-MM-DD` string by whole days. Never touches a timezone. */
export function shiftDate(date: DateString, offsetDays: number): DateString {
  const anchored = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(anchored.getTime())) {
    throw new Error(`Not a YYYY-MM-DD date string: ${date}`);
  }
  return formatInTimeZone(addDays(anchored, offsetDays), 'UTC', DATE_FORMAT);
}

/** Inclusive list of dates from `from` to `to`. Both are Pacific dates. */
export function dateRange(from: DateString, to: DateString): DateString[] {
  const out: DateString[] = [];
  for (let d = from; d <= to; d = shiftDate(d, 1)) {
    out.push(d);
    if (out.length > 1000) throw new Error(`Refusing to expand a range over 1000 days: ${from}..${to}`);
  }
  return out;
}

/** Whole days between two Pacific dates, `to - from`. */
export function daysBetween(from: DateString, to: DateString): number {
  const a = new Date(`${from}T00:00:00Z`).getTime();
  const b = new Date(`${to}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000);
}

/**
 * The instant a Pacific Time hour bucket begins.
 *
 * Search Console's `hour` dimension is an hour of the Pacific day, so
 * `2026-09-12` hour 0 begins at Pacific midnight — 07:00 or 08:00 UTC
 * depending on DST. Used to place hourly rows on a real time axis.
 */
export function pacificHourToInstant(date: DateString, hour: number): Date {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error(`GSC hour must be an integer 0-23, got: ${hour}`);
  }
  return fromZonedTime(`${date} ${String(hour).padStart(2, '0')}:00:00`, GSC_TIMEZONE);
}

/**
 * The span a Pacific calendar day covers in another timezone.
 *
 * Presentation only. A Pacific day is not a day anywhere else — it straddles
 * two IST dates — so a dashboard showing "12 Sep" for a GSC row is showing a
 * Pacific date, and this is what lets the UI say so honestly rather than
 * silently relabelling it.
 */
export function pacificDayInZone(
  date: DateString,
  timeZone: string,
): { start: Date; end: Date; startLabel: string; endLabel: string; spansTwoDays: boolean } {
  const start = fromZonedTime(`${date} 00:00:00`, GSC_TIMEZONE);
  const end = fromZonedTime(`${date} 23:59:59`, GSC_TIMEZONE);
  const startLabel = formatInTimeZone(start, timeZone, DATE_FORMAT);
  const endLabel = formatInTimeZone(end, timeZone, DATE_FORMAT);

  return { start, end, startLabel, endLabel, spansTwoDays: startLabel !== endLabel };
}

/** Format an instant for display in a property's timezone. */
export function formatInProperty(instant: Date, timeZone: string, pattern = 'd MMM yyyy, HH:mm'): string {
  return formatInTimeZone(instant, timeZone, pattern);
}
