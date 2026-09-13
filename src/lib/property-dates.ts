import { formatInTimeZone } from 'date-fns-tz';

import type { DateString } from './gsc-dates';

/**
 * The PROPERTY's calendar day — deliberately not in `gsc-dates.ts`.
 *
 * There are two day grids in this product and they are not the same grid:
 *
 *   - A Search Console date is a PACIFIC calendar day. Google assigns it, we
 *     store it exactly as returned, and `gsc-dates.ts` owns it.
 *   - A `daily_rank_rollups.day` is a PROPERTY-timezone day:
 *     `(serp_checks.checked_at AT TIME ZONE properties.timezone)::date`
 *     (`src/server/ops/rollups.ts`). "Moved today" has to mean what the client
 *     means by today, and grouping a Noida property's checks by Pacific days
 *     would split every Indian evening across two rollup rows.
 *
 * Asia/Kolkata is UTC+5:30 and Pacific is UTC−7/−8, so the two are 12.5–13.5
 * hours apart: for the whole Indian working morning, "today in India" is still
 * "yesterday in Pacific".
 *
 * This module exists so that indexing one grid with the other's date is a
 * visible import rather than an invisible mistake. It happened: the dashboard
 * computed its rollup baselines with `pacificToday()`, so for half of every day
 * the 24h/7d/28d deltas read one rollup day too far back — and, when the
 * intervening day moved the other way, rendered a green "improved" arrow for a
 * keyword that had fallen.
 *
 * Rule of thumb: if the value will be compared against `gsc_snapshots.gsc_date`
 * it is a Pacific date; if it will be compared against `daily_rank_rollups.day`
 * it is a property date. Nothing legitimately compares one to the other.
 */

/** Today, in the property's own timezone. */
export function propertyToday(timeZone: string, instant: Date = new Date()): DateString {
  return formatInTimeZone(instant, timeZone, 'yyyy-MM-dd');
}
