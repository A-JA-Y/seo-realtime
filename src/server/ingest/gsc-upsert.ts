import { sql } from 'drizzle-orm';

import type { Logger } from '@/lib/logger';
import type { DateString } from '@/lib/gsc-dates';
import { db } from '@/server/db';
import { gscSnapshots, type GscDataState, type NewGscSnapshot } from '@/server/db/schema';
import { parseDateKey, parseHourKey, type GscRow } from './gsc-client';
import { weightedPosition } from './gsc-series';

/**
 * Mapping Search Console rows into `gsc_snapshots`, idempotently.
 *
 * Domain rule 9: "Every ingest is idempotent. Unique constraint on the natural
 * key of every snapshot table plus ON CONFLICT DO UPDATE. Crons retry,
 * schedulers double-fire, and backfills get re-run by hand."
 */

/** Which dimension sits at which index, derived from the request. */
export interface DimensionLayout {
  date: number | null;
  hour: number | null;
}

export function layoutFor(dimensions: readonly string[]): DimensionLayout {
  const date = dimensions.indexOf('date');
  const hour = dimensions.indexOf('hour');
  return { date: date === -1 ? null : date, hour: hour === -1 ? null : hour };
}

export interface MappedRow {
  gscDate: DateString;
  gscHour: number | null;
  clicks: number;
  impressions: number;
  ctr: string;
  position: string | null;
}

export interface MapResult {
  rows: MappedRow[];
  /** Rows Google returned that we refused to store, with the reason. */
  rejected: Array<{ keys: string[]; reason: string }>;
}

/**
 * Turn validated API rows into storable rows.
 *
 * `fallbackDate` supplies the date when the request did not group by `date` —
 * the per-date fallback shape issues one request per day, so the day is known
 * from the request rather than from the response. When the `hour` key arrives
 * as a full ISO timestamp it carries its own date, which takes precedence.
 */
export function mapGscRows(
  apiRows: readonly GscRow[],
  options: { dimensions: readonly string[]; fallbackDate?: DateString },
): MapResult {
  const layout = layoutFor(options.dimensions);
  const rows: MappedRow[] = [];
  const rejected: Array<{ keys: string[]; reason: string }> = [];

  for (const row of apiRows) {
    const keys = row.keys;

    // Dates are taken LITERALLY from the key, never through a Date round trip.
    // Domain rule 4: never shift a Pacific date during ingestion.
    const hourKey = layout.hour === null ? null : keys[layout.hour];
    const dateKey = layout.date === null ? null : keys[layout.date];

    const gscDate =
      (dateKey ? parseDateKey(dateKey) : null) ??
      (hourKey ? parseDateKey(hourKey) : null) ??
      options.fallbackDate ??
      null;

    if (!gscDate) {
      rejected.push({ keys, reason: 'no date in the response keys and no fallback date supplied' });
      continue;
    }

    let gscHour: number | null = null;
    if (layout.hour !== null) {
      gscHour = typeof hourKey === 'string' ? parseHourKey(hourKey) : null;
      if (gscHour === null) {
        rejected.push({ keys, reason: `unparseable hour key: ${JSON.stringify(hourKey ?? null)}` });
        continue;
      }
    }

    // §5: "Rows with impressions = 0 store position = NULL." Google reports a
    // position for a row nobody saw; it means nothing and would drag averages.
    let position = row.impressions > 0 ? (row.position ?? null) : null;

    // Position 1 is the best value that exists. Anything below it is a shape we
    // do not understand, and storing it would put a point ABOVE first place on
    // an inverted axis. Drop the value, keep the row's clicks and impressions.
    if (position !== null && position < 1) {
      rejected.push({ keys, reason: `position below 1 (${position}); stored as NULL` });
      position = null;
    }

    rows.push({
      gscDate,
      gscHour,
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr.toFixed(6),
      position: position === null ? null : position.toFixed(2),
    });
  }

  return { rows: mergeDuplicates(rows), rejected };
}

/**
 * Merge rows that collapse onto the same natural key.
 *
 * Two causes, one fix:
 *
 *  1. The Pacific fall-back day is 25 hours long, but `gsc_hour` is a clock
 *     LABEL 0-23 — hour 1 happens twice and shares one label. If Google returns
 *     both buckets as bare "1", they are genuinely two observations of one slot.
 *
 *  2. Any duplicate in a response.
 *
 * Postgres refuses `ON CONFLICT DO UPDATE` when one statement touches the same
 * row twice ("cannot affect row a second time"), so leaving duplicates in a
 * batch is not merely imprecise — it throws and loses the whole batch.
 *
 * Merging sums clicks and impressions and impression-weights the positions,
 * which is the honest reading: the label covered both hours.
 */
function mergeDuplicates(rows: readonly MappedRow[]): MappedRow[] {
  const byKey = new Map<string, MappedRow[]>();

  for (const row of rows) {
    const key = `${row.gscDate}|${row.gscHour ?? 'null'}`;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(row);
    else byKey.set(key, [row]);
  }

  const merged: MappedRow[] = [];

  for (const bucket of byKey.values()) {
    const first = bucket[0] as MappedRow;
    if (bucket.length === 1) {
      merged.push(first);
      continue;
    }

    let clicks = 0;
    let impressions = 0;

    for (const row of bucket) {
      clicks += row.clicks;
      impressions += row.impressions;
    }

    // The SAME primitive the read path uses. A second copy of this formula is a
    // second average: float accumulation plus `toFixed(2)` disagrees with the
    // integer-hundredths form by 0.01 on exact ties (verified), which would
    // surface as a phantom revision in the acceptance-criterion-10 tooltip.
    const { position } = weightedPosition(bucket);

    merged.push({
      gscDate: first.gscDate,
      gscHour: first.gscHour,
      clicks,
      impressions,
      ctr: (impressions > 0 ? clicks / impressions : 0).toFixed(6),
      position: position === null ? null : position.toFixed(2),
    });
  }

  return merged;
}

/**
 * Postgres caps a statement at 65,535 bound parameters. At 9 columns per row
 * that is ~7,200 rows; 500 leaves generous headroom and keeps each statement
 * small enough to retry cheaply.
 */
const UPSERT_CHUNK = 500;

export interface UpsertOptions {
  propertyId: string;
  keywordId: string;
  dataState: GscDataState;
  log?: Logger;
}

/**
 * Write rows idempotently.
 *
 * `ON CONFLICT DO UPDATE` on the natural key, which is
 * `UNIQUE NULLS NOT DISTINCT (keyword_id, gsc_date, gsc_hour, data_state)` —
 * the NULLS NOT DISTINCT part is what makes this work at all for daily rows,
 * where `gsc_hour` is NULL on every row. See NOTES.md §1.
 *
 * Returns the number of rows written, which for an idempotent re-run is the
 * same count as the first run: acceptance criterion 2 asks for identical row
 * counts in the TABLE, not for the second run to write nothing.
 */
export async function upsertGscSnapshots(
  rows: readonly MappedRow[],
  options: UpsertOptions,
): Promise<number> {
  if (rows.length === 0) return 0;

  let written = 0;

  for (let offset = 0; offset < rows.length; offset += UPSERT_CHUNK) {
    const chunk = rows.slice(offset, offset + UPSERT_CHUNK);

    const values: NewGscSnapshot[] = chunk.map((row) => ({
      propertyId: options.propertyId,
      keywordId: options.keywordId,
      gscDate: row.gscDate,
      gscHour: row.gscHour,
      dataState: options.dataState,
      clicks: row.clicks,
      impressions: row.impressions,
      ctr: row.ctr,
      position: row.position,
    }));

    const result = await db
      .insert(gscSnapshots)
      .values(values)
      .onConflictDoUpdate({
        target: [
          gscSnapshots.keywordId,
          gscSnapshots.gscDate,
          gscSnapshots.gscHour,
          gscSnapshots.dataState,
        ],
        set: {
          clicks: sql`excluded.clicks`,
          impressions: sql`excluded.impressions`,
          ctr: sql`excluded.ctr`,
          position: sql`excluded.position`,
          fetchedAt: sql`now()`,
        },
      })
      .returning({ id: gscSnapshots.id });

    written += result.length;
  }

  return written;
}
