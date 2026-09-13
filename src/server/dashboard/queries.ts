import { and, eq, sql } from 'drizzle-orm';

import { pacificToday, shiftDate, type DateString } from '@/lib/gsc-dates';
import { propertyToday } from '@/lib/property-dates';
import { MIN_CHECKS_PER_DAY } from '@/server/alerts/rules';
import type { PropertyScope } from '@/server/db/scoped';
import { db } from '@/server/db';
import { alerts, keywordTargets, keywords, serpChecks } from '@/server/db/schema';
import { getGscSeriesForKeywords } from '@/server/ingest/gsc-read';
import { toNumber, type GscSeriesPoint } from '@/server/ingest/gsc-series';
import type { SerpFeatures } from '@/server/ingest/serp-parse';

/**
 * Dashboard reads (§11).
 *
 * Everything here is driven by a `PropertyScope`, which cannot be constructed
 * without passing the tenancy check — so no query in this file can read another
 * tenant's rows.
 *
 * Every returned figure carries its SOURCE. §11: "Label the source on every
 * tile" and acceptance criterion 7: "Every position number rendered anywhere in
 * the UI is labelled with its source."
 */

/** The two kinds of number this product reports. They are never mixed. */
export type NumberSource = 'live rank' | 'Search Console average';

export interface KeywordRow {
  keywordId: string;
  term: string;
  isPrimary: boolean;
  keywordTargetId: string | null;
  locationName: string | null;
  device: 'desktop' | 'mobile' | null;

  /** Live rank. Null means not found, or never checked — never a sentinel. */
  rankGroup: number | null;
  rankAbsolute: number | null;
  furnitureGap: number | null;
  found: boolean | null;
  checkedAt: Date | null;
  rankingUrl: string | null;
  serpFeatures: SerpFeatures | null;

  /** Positive = worsened, negative = improved. Null when either end is missing. */
  delta24h: number | null;
  delta7d: number | null;
  delta28d: number | null;

  /**
   * Search Console, kept separate and labelled.
   *
   * This is the freshest reading the resolver hands back — which is usually two
   * or three days behind the live check beside it, because Google finalises
   * slowly. `gscDate` is what makes that lag visible rather than implied; a
   * column that showed the number without the date would invite the reader to
   * compare it with a rank checked ten minutes ago.
   */
  gscPosition: number | null;
  gscDate: DateString | null;
  gscSource: GscSeriesPoint['source'] | null;
  gscIsProvisional: boolean;
  gscImpressions: number | null;
  isLowConfidence: boolean;
}

/**
 * One row per keyword target, with the latest check and its deltas.
 *
 * Deltas come from `daily_rank_rollups.best_rank_group`, not from single
 * checks — §9 is explicit that a single check is too noisy to act on, and a
 * table whose Δ column disagreed with the alert engine's baseline would be
 * worse than no Δ column.
 *
 * So BOTH sides of the delta are rollup values, and both are gated on the same
 * minimum check count the alert engine uses. It used to subtract a rollup
 * baseline from the LATEST SINGLE CHECK — a point against a daily minimum,
 * which is not a comparison of like with like and flips sign whenever the day's
 * best check is better than the moment you happen to look. The rank COLUMN is
 * still the latest check, because that is the near-realtime promise; the Δ
 * column is explicitly "best of today vs best of that day".
 *
 * The anchor is the PROPERTY's day, not the Pacific day. `daily_rank_rollups`
 * is bucketed in the property timezone; indexing it with `pacificToday()` read
 * one day too far back for the 12.5–13.5 hours each day that the two grids
 * disagree — the whole Indian working morning — and rendered an "improved"
 * arrow for keywords that had fallen. See `src/lib/property-dates.ts`.
 *
 * A missing baseline yields a NULL delta rather than a zero. Zero means "did
 * not move", which is a claim; null means "we cannot say".
 */
export async function keywordRows(scope: PropertyScope): Promise<KeywordRow[]> {
  const property = await scope.property();
  if (!property) return [];

  const today = propertyToday(property.timezone);

  const result = await db.execute<{
    keyword_id: string;
    term: string;
    is_primary: boolean;
    keyword_target_id: string | null;
    location_name: string | null;
    device: 'desktop' | 'mobile' | null;
    rank_group: number | null;
    rank_absolute: number | null;
    found: boolean | null;
    checked_at: Date | string | null;
    ranking_url: string | null;
    serp_features: SerpFeatures | null;
    today_best: number | null;
    base_24h: number | null;
    base_7d: number | null;
    base_28d: number | null;
  }>(sql`
    WITH latest AS (
      SELECT DISTINCT ON (sc.keyword_target_id)
        sc.keyword_target_id, sc.rank_group, sc.rank_absolute, sc.found,
        sc.checked_at, sc.ranking_url, sc.serp_features
      FROM serp_checks sc
      WHERE sc.property_id = ${scope.propertyId}
      ORDER BY sc.keyword_target_id, sc.checked_at DESC
    ),
    /*
     * Both ends of every delta come from here, so both are the same kind of
     * number. The checks_count floor is the alert engine's own gate (§9: never
     * a single check) — a rollup built from one check IS that check.
     */
    baseline AS (
      SELECT
        r.keyword_target_id,
        MIN(r.best_rank_group) FILTER (
          WHERE r.day = ${today}::date AND r.checks_count >= ${MIN_CHECKS_PER_DAY}
        ) AS today_best,
        MIN(r.best_rank_group) FILTER (
          WHERE r.day = ${shiftDate(today, -1)}::date AND r.checks_count >= ${MIN_CHECKS_PER_DAY}
        ) AS base_24h,
        MIN(r.best_rank_group) FILTER (
          WHERE r.day = ${shiftDate(today, -7)}::date AND r.checks_count >= ${MIN_CHECKS_PER_DAY}
        ) AS base_7d,
        MIN(r.best_rank_group) FILTER (
          WHERE r.day = ${shiftDate(today, -28)}::date AND r.checks_count >= ${MIN_CHECKS_PER_DAY}
        ) AS base_28d
      FROM daily_rank_rollups r
      JOIN keyword_targets kt ON kt.id = r.keyword_target_id
      WHERE kt.property_id = ${scope.propertyId}
      GROUP BY r.keyword_target_id
    )
    SELECT
      k.id AS keyword_id, k.term, k.is_primary,
      kt.id AS keyword_target_id, kt.location_name, kt.device,
      l.rank_group, l.rank_absolute, l.found, l.checked_at, l.ranking_url, l.serp_features,
      b.today_best, b.base_24h, b.base_7d, b.base_28d
    FROM keywords k
    LEFT JOIN keyword_targets kt ON kt.keyword_id = k.id AND kt.is_active
    LEFT JOIN latest l   ON l.keyword_target_id = kt.id
    LEFT JOIN baseline b ON b.keyword_target_id = kt.id
    WHERE k.property_id = ${scope.propertyId} AND k.is_active
    ORDER BY k.is_primary DESC, k.term, kt.location_name
  `);

  const rows: KeywordRow[] = result.rows.map((row) => {
    const rankGroup = row.rank_group;

    // Rollup best vs rollup best. Never the latest check against a daily
    // minimum: that compares a point with an aggregate and flips sign whenever
    // the day's best check beats the moment you looked.
    const delta = (baseline: number | null) =>
      row.today_best === null || baseline === null ? null : row.today_best - baseline;

    return {
      keywordId: row.keyword_id,
      term: row.term,
      isPrimary: row.is_primary,
      keywordTargetId: row.keyword_target_id,
      locationName: row.location_name,
      device: row.device,
      rankGroup,
      rankAbsolute: row.rank_absolute,
      furnitureGap:
        rankGroup !== null && row.rank_absolute !== null ? row.rank_absolute - rankGroup : null,
      found: row.found,
      checkedAt: toDate(row.checked_at),
      rankingUrl: row.ranking_url,
      serpFeatures: row.serp_features,
      delta24h: delta(row.base_24h),
      delta7d: delta(row.base_7d),
      delta28d: delta(row.base_28d),
      gscPosition: null,
      gscDate: null,
      gscSource: null,
      gscIsProvisional: false,
      gscImpressions: null,
      isLowConfidence: false,
    };
  });

  // PACIFIC, not `today` — this reads gsc_snapshots.gsc_date, the other day
  // grid. Passing the property day here would ask Google's calendar a question
  // in India's calendar; see src/lib/property-dates.ts.
  return attachGscReadings(rows, pacificToday());
}

/**
 * Attach each keyword's freshest Search Console reading.
 *
 * Deliberately a second round trip through `getGscSeriesForKeywords` rather
 * than a join. §5 says the precedence rule (final > fresh > hourly) lives in
 * exactly one function; a CTE that re-implemented it here would be a second
 * definition, and the day it drifted the table and the chart would disagree
 * about the same keyword while both looked right.
 */
async function attachGscReadings(
  rows: KeywordRow[],
  /** A PACIFIC date. `gsc_snapshots.gsc_date` is Google's calendar, not ours. */
  pacificDay: DateString,
): Promise<KeywordRow[]> {
  const keywordIds = [...new Set(rows.map((r) => r.keywordId))];
  if (keywordIds.length === 0) return rows;

  // Google finalises at T−3/T−4, so a window shorter than this can legitimately
  // be empty for a healthy property.
  const series = await getGscSeriesForKeywords(
    keywordIds,
    shiftDate(pacificDay, -10),
    pacificDay,
  );

  for (const row of rows) {
    const points = series.get(row.keywordId) ?? [];
    // Dense series, newest last. The freshest reading is the last point we
    // actually hold anything for — a 'none' date is a hole, not a zero.
    const latest = [...points].reverse().find((p) => p.source !== 'none' && p.position !== null);
    if (!latest) continue;

    row.gscPosition = latest.position;
    row.gscDate = latest.date;
    row.gscSource = latest.source;
    row.gscIsProvisional = latest.isProvisional;
    row.gscImpressions = latest.positionImpressions;
    row.isLowConfidence = latest.isLowConfidence;
  }

  return rows;
}

/** Raw `db.execute` hands timestamps back as strings. See NOTES.md §49. */
function toDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/* ══════════════════════════════════════════════════════════════════════════
   Overview tiles
   ══════════════════════════════════════════════════════════════════════════ */

export interface OverviewTile {
  label: string;
  value: string;
  /** What this number IS. Rendered next to it, always. */
  source: NumberSource | 'configuration';
  /** Positive = worse for ranks. Null when there is no baseline. */
  delta: number | null;
  deltaLabel: string;
  /** Lower is better for rank values, so the arrow flips. */
  lowerIsBetter: boolean;
  sparkline: Array<{ day: string; value: number | null }>;
  note?: string;
}

export interface Overview {
  tiles: OverviewTile[];
  rows: KeywordRow[];
}

/**
 * The four tiles §11 specifies, each labelled with where its number came from.
 *
 * "Average rank_group across primaries" is a live-rank number; impressions are
 * a Search Console number. They are never combined into one figure — mixing
 * them is domain rule 1, and the labels are what make the separation visible
 * rather than merely true.
 */
export async function overview(scope: PropertyScope): Promise<Overview> {
  const rows = await keywordRows(scope);

  const property = await scope.property();
  if (!property) return { rows, tiles: [] };

  // The PROPERTY's day, because the sparkline reads rollups. Pacific dates
  // belong to gsc_snapshots and nothing else — see src/lib/property-dates.ts.
  const today = propertyToday(property.timezone);

  const spark = await rankSparkline(scope, today);

  const withRank = rows.filter((r) => r.rankGroup !== null);
  const primaries = withRank.filter((r) => r.isPrimary);
  const inTopTen = withRank.filter((r) => r.rankGroup! <= 10);
  const movedToday = rows.filter((r) => r.delta24h !== null && r.delta24h !== 0);

  const avgPrimary =
    primaries.length > 0
      ? primaries.reduce((sum, r) => sum + r.rankGroup!, 0) / primaries.length
      : null;

  const yesterdayAvg = spark.at(-2)?.value ?? null;

  const distinctKeywords = new Set(rows.map((r) => r.keywordId)).size;

  return {
    rows,
    tiles: [
      {
        label: 'Tracked keywords',
        value: String(distinctKeywords),
        source: 'configuration',
        delta: null,
        deltaLabel: `${rows.filter((r) => r.keywordTargetId).length} location/device targets`,
        lowerIsBetter: false,
        sparkline: [],
      },
      {
        label: 'Average rank, primaries',
        value: avgPrimary === null ? '—' : avgPrimary.toFixed(1),
        source: 'live rank',
        delta: avgPrimary !== null && yesterdayAvg !== null ? avgPrimary - yesterdayAvg : null,
        deltaLabel: 'vs yesterday',
        lowerIsBetter: true,
        sparkline: spark,
        note: `organic position across ${primaries.length} primary target${primaries.length === 1 ? '' : 's'}`,
      },
      {
        label: 'In the top 10',
        value: String(inTopTen.length),
        source: 'live rank',
        delta: null,
        deltaLabel: `of ${withRank.length} currently found`,
        lowerIsBetter: false,
        sparkline: [],
      },
      {
        label: 'Moved today',
        value: String(movedToday.length),
        source: 'live rank',
        delta: null,
        deltaLabel: 'vs the 24h rollup baseline',
        lowerIsBetter: false,
        sparkline: [],
      },
    ],
  };
}

/**
 * Seven days of average primary rank, for the tile sparkline.
 *
 * `today` is a PROPERTY-timezone day. When this window was computed in Pacific
 * time it ended one day short of the property's today for half of every day, so
 * the tile's headline number — computed from live checks — sat above a
 * sparkline that did not include it, and the two disagreed on screen.
 *
 * The is_active filters match `keywordRows`: without them the sparkline
 * averages a different population from the tile above it, and deactivating a
 * keyword reads as a movement.
 */
async function rankSparkline(
  scope: PropertyScope,
  today: DateString,
): Promise<Array<{ day: string; value: number | null }>> {
  const from = shiftDate(today, -6);

  const result = await db.execute<{ day: string; avg: string | null }>(sql`
    SELECT to_char(r.day, 'YYYY-MM-DD') AS day,
           ROUND(AVG(r.best_rank_group)::numeric, 2)::text AS avg
    FROM daily_rank_rollups r
    JOIN keyword_targets kt ON kt.id = r.keyword_target_id AND kt.is_active
    JOIN keywords k ON k.id = kt.keyword_id AND k.is_primary AND k.is_active
    WHERE kt.property_id = ${scope.propertyId}
      AND r.day BETWEEN ${from}::date AND ${today}::date
    GROUP BY r.day
    ORDER BY r.day
  `);

  const byDay = new Map(result.rows.map((r) => [r.day, toNumber(r.avg, 'avg')]));

  // Dense: a day with no rollup is a null, not a missing point. The chart must
  // render a gap there, never join across it.
  const days: Array<{ day: string; value: number | null }> = [];
  for (let d = from; d <= today; d = shiftDate(d, 1)) {
    days.push({ day: d, value: byDay.get(d) ?? null });
  }
  return days;
}

/* ══════════════════════════════════════════════════════════════════════════
   Competitors
   ══════════════════════════════════════════════════════════════════════════ */

export interface CompetitorRow {
  domain: string;
  /** How many of the property's tracked SERPs this domain appears on. */
  /** Distinct tracked SERPs this domain appears on — not slots occupied. */
  appearances: number;
  /** Null when every appearance carried a null rank_group. Never 0. */
  bestRank: number | null;
  averageRank: number | null;
  /** Keywords where this domain currently outranks us. */
  outranksUsOn: string[];
  lastSeen: Date | null;
}

/** A competitor last seen longer ago than this is history, not the landscape. */
const COMPETITOR_WINDOW_DAYS = 30;

/**
 * The competitive landscape across every tracked SERP (§11).
 *
 * Built from the competitor lists already captured on each check — the payload
 * was paid for either way, and §6 calls capturing it core rather than optional.
 *
 * Three things this gets right that it used to get wrong:
 *
 *  - "SERPs" counts DISTINCT targets, not rows. A domain holding two organic
 *    slots on one page was counted twice, so a site with a sitelinks-style
 *    double listing outranked one that appeared on twice as many keywords.
 *  - A null `rank_group` stays null. `Number(null)` is 0, so a competitor whose
 *    rank the provider did not report rendered as "Average rank 0.0" — a
 *    position better than first, and exactly the sentinel domain rule 5 forbids.
 *  - Only active targets, and only recent checks. Without either, a keyword
 *    nobody tracks any more keeps populating the table from its last check,
 *    for ever.
 */
export async function competitors(scope: PropertyScope, limit = 25): Promise<CompetitorRow[]> {
  const result = await db.execute<{
    domain: string;
    appearances: number;
    best_rank: number | null;
    average_rank: string | null;
    outranks_us_on: string[] | null;
    last_seen: Date | string | null;
  }>(sql`
    WITH latest AS (
      SELECT DISTINCT ON (sc.keyword_target_id)
        sc.keyword_target_id, sc.keyword_id, sc.rank_group AS our_rank,
        sc.competing_domains, sc.checked_at
      FROM serp_checks sc
      JOIN keyword_targets kt ON kt.id = sc.keyword_target_id AND kt.is_active
      JOIN keywords kw ON kw.id = kt.keyword_id AND kw.is_active
      WHERE sc.property_id = ${scope.propertyId}
        AND sc.checked_at >= now() - (${COMPETITOR_WINDOW_DAYS} * interval '1 day')
      ORDER BY sc.keyword_target_id, sc.checked_at DESC
    ),
    flat AS (
      SELECT
        l.keyword_target_id, l.keyword_id, l.our_rank, l.checked_at,
        (c->>'domain')::text AS domain,
        (c->>'rank_group')::int AS rank_group
      FROM latest l
      CROSS JOIN LATERAL jsonb_array_elements(l.competing_domains) AS c
      WHERE c->>'domain' IS NOT NULL
    )
    SELECT
      f.domain,
      COUNT(DISTINCT f.keyword_target_id)::int AS appearances,
      MIN(f.rank_group)::int AS best_rank,
      ROUND(AVG(f.rank_group)::numeric, 1)::text AS average_rank,
      ARRAY_AGG(DISTINCT k.term) FILTER (
        WHERE f.our_rank IS NOT NULL AND f.rank_group < f.our_rank
      ) AS outranks_us_on,
      MAX(f.checked_at) AS last_seen
    FROM flat f
    JOIN keywords k ON k.id = f.keyword_id
    GROUP BY f.domain
    ORDER BY COUNT(DISTINCT f.keyword_target_id) DESC, MIN(f.rank_group) ASC NULLS LAST
    LIMIT ${limit}
  `);

  return result.rows.map((row) => ({
    domain: row.domain,
    appearances: row.appearances,
    // Never Number(null): that is 0, a position better than first.
    bestRank: row.best_rank,
    averageRank: row.average_rank === null ? null : Number(row.average_rank),
    outranksUsOn: row.outranks_us_on ?? [],
    lastSeen: toDate(row.last_seen),
  }));
}

/* ══════════════════════════════════════════════════════════════════════════
   Keyword detail
   ══════════════════════════════════════════════════════════════════════════ */

export interface RankPoint {
  checkedAt: Date;
  rankGroup: number | null;
  rankAbsolute: number | null;
  found: boolean;
  serpFeatures: SerpFeatures | null;
  rankingUrl: string | null;
}

/** Every check for one target, oldest first. Nulls stay null. */
export async function rankHistory(
  scope: PropertyScope,
  keywordTargetId: string,
  days = 28,
): Promise<RankPoint[]> {
  const rows = await scope.serpChecks(
    and(
      eq(serpChecks.keywordTargetId, keywordTargetId),
      sql`${serpChecks.checkedAt} >= now() - (${days} * interval '1 day')`,
    )!,
  );

  return rows
    .map((row) => ({
      checkedAt: row.checkedAt,
      rankGroup: row.rankGroup,
      rankAbsolute: row.rankAbsolute,
      found: row.found,
      serpFeatures: (row.serpFeatures as SerpFeatures | null) ?? null,
      rankingUrl: row.rankingUrl,
    }))
    .sort((a, b) => a.checkedAt.getTime() - b.checkedAt.getTime());
}

export interface RankingUrlChange {
  at: Date;
  /** Both ends are real URLs: a change is a swap, never an appearance. */
  from: string;
  to: string;
}

/**
 * When the ranking URL changed (§11, domain rule 7).
 *
 * "A stable position with a changed ranking URL is a notable event, not a
 * non-event" — so the history is of CHANGES, not of every check repeating the
 * same URL.
 *
 * Checks that found nothing are SKIPPED rather than treated as a change to no
 * URL. A keyword that drops out of the top 100 and comes back on the same page
 * would otherwise be reported as two URL swaps, which is a different event with
 * a different cause — and the one this list exists to surface, Google quietly
 * preferring a different page of yours, would be buried among them.
 */
export function rankingUrlChanges(history: readonly RankPoint[]): RankingUrlChange[] {
  const changes: RankingUrlChange[] = [];
  let previous: string | undefined;

  for (const point of history) {
    if (!point.found || point.rankingUrl === null) continue;

    if (previous !== undefined && point.rankingUrl !== previous) {
      changes.push({ at: point.checkedAt, from: previous, to: point.rankingUrl });
    }
    previous = point.rankingUrl;
  }

  return changes.reverse();
}

/** Targets for one keyword, so the detail page can offer a location switcher. */
export async function targetsForKeyword(scope: PropertyScope, keywordId: string) {
  return scope.keywordTargets(eq(keywordTargets.keywordId, keywordId));
}

export async function keywordById(scope: PropertyScope, keywordId: string) {
  const [row] = await scope.keywords(eq(keywords.id, keywordId));
  return row;
}


/* ══════════════════════════════════════════════════════════════════════════
   Alerts (read side — the engine that writes them is M7)
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Unread, unresolved alerts for the nav badge.
 *
 * Takes a property id rather than a scope because the layout that renders the
 * badge has already resolved the scope; the count is read inside that same
 * request, after the access check that produced it.
 */
export async function unreadAlertCount(propertyId: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(alerts)
    .where(
      and(
        eq(alerts.propertyId, propertyId),
        sql`${alerts.readAt} IS NULL`,
        sql`${alerts.resolvedAt} IS NULL`,
      ),
    );

  return row?.count ?? 0;
}

export interface AlertRow {
  id: string;
  type: string;
  severity: string;
  title: string;
  body: string;
  keywordId: string | null;
  keywordTargetId: string | null;
  /** Always carries `day`: the rollup day the engine judged this on. */
  payload: Record<string, unknown>;
  createdAt: Date;
  readAt: Date | null;
  resolvedAt: Date | null;
}

/**
 * The in-app alert feed. There is no other delivery channel, by design (§9).
 *
 * Open and unread first, then open and read, then resolved — a feed ordered
 * purely by time buries a critical alert from Tuesday under Thursday's
 * informational ones.
 */
export async function listAlerts(scope: PropertyScope, limit = 100): Promise<AlertRow[]> {
  const rows = await scope.alerts();

  const rank = (row: (typeof rows)[number]) =>
    row.resolvedAt !== null ? 2 : row.readAt !== null ? 1 : 0;

  return rows
    .sort((a, b) => rank(a) - rank(b) || b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, limit)
    .map((row) => ({
      id: row.id,
      type: row.type,
      severity: row.severity,
      title: row.title,
      body: row.body,
      keywordId: row.keywordId,
      keywordTargetId: row.keywordTargetId,
      payload: (row.payload ?? {}) as Record<string, unknown>,
      createdAt: row.createdAt,
      readAt: row.readAt,
      resolvedAt: row.resolvedAt,
    }));
}
