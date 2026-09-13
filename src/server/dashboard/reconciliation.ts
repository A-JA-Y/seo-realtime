import { and, eq, sql } from 'drizzle-orm';

import { pacificHourToInstant, shiftDate, type DateString } from '@/lib/gsc-dates';
import { db } from '@/server/db';
import { keywordTargets, serpChecks } from '@/server/db/schema';
import {
  LOW_CONFIDENCE_IMPRESSIONS,
  toNumber,
  type GscSeriesPoint,
} from '@/server/ingest/gsc-series';
import type { SerpFeatures } from '@/server/ingest/serp-parse';

/**
 * "Why these numbers differ" (§8).
 *
 * The feature that justifies the build. Search Console says 13.4; the client
 * looks at their phone and sees 7. Both are right, and the gap has two causes
 * this panel names from the data:
 *
 *  1. **What is being counted.** Google's average position counts every SERP
 *     element — AI Overviews, local packs, image blocks. A human counting blue
 *     links does not. That is `rank_absolute` vs `rank_group`.
 *
 *  2. **What is being averaged.** GSC blends every device, location and query
 *     variant in the window into one click-weighted mean. A SERP check is one
 *     device at one pinned location at one moment.
 *
 * Nothing here ever averages a Search Console position together with a
 * DataForSEO rank (domain rule 1). They sit side by side, each labelled.
 */

export type Confidence = 'low' | 'normal' | 'none';

/** The Search Console side: one number for the keyword, whatever the location. */
export interface GscSide {
  source: 'Search Console average position';
  date: DateString;
  position: number | null;
  impressions: number | null;
  clicks: number | null;
  /** `final` / `fresh` / `hourly` / `none`. Shown so the reader knows how settled it is. */
  state: GscSeriesPoint['source'];
  isProvisional: boolean;
  confidence: Confidence;
}

/** The SERP side: one per pinned location and device, because that is what it is. */
export interface SerpSide {
  source: 'Live rank check';
  keywordTargetId: string;
  locationName: string;
  device: 'desktop' | 'mobile';
  checkedAt: Date | null;
  /**
   * `true` found, `false` checked and absent, `null` NEVER CHECKED near this
   * date.
   *
   * The three states are not two. Collapsing null to false made an active
   * target that simply has no check in the window render as a critical "not
   * found" — i.e. the panel announced a ranking collapse whenever SERP ingest
   * paused (balance exhausted, credentials rotated, a new target before its
   * first pingback) while Search Console kept flowing. That is the opposite of
   * domain rule 5's spirit: absence of evidence became evidence of absence.
   */
  found: boolean | null;
  /** Organic-only: "which blue link am I". */
  rankGroup: number | null;
  /** All-elements: how far down the page. This is what reconciles with GSC. */
  rankAbsolute: number | null;
  /** rank_absolute − rank_group: how much SERP furniture sits above you. */
  furnitureGap: number | null;
  serpFeatures: SerpFeatures | null;
  rankingUrl: string | null;
  /** How far the nearest check is from the requested date, in hours. */
  hoursFromDate: number | null;
}

export interface Reconciliation {
  keywordId: string;
  term: string;
  date: DateString;
  gsc: GscSide;
  targets: SerpSide[];
  /** Plain-language explanation, generated from the values above. */
  explanation: string[];
}

/* ══════════════════════════════════════════════════════════════════════════
   Feature naming
   ══════════════════════════════════════════════════════════════════════════ */

/** Human names for the blocks, in the order they usually appear on the page. */
const FEATURE_LABELS: Array<[keyof SerpFeatures, string, string]> = [
  ['ai_overview', 'an AI Overview', 'AI Overviews'],
  ['local_pack', 'a local pack', 'local packs'],
  ['images', 'an images block', 'image blocks'],
  ['video', 'a video block', 'video blocks'],
  ['top_stories', 'a Top Stories block', 'Top Stories blocks'],
  ['people_also_ask', 'a People Also Ask block', 'People Also Ask blocks'],
];

/** The blocks present, named, longest-standing first. */
export function describeFeatures(features: SerpFeatures | null): string[] {
  if (!features) return [];

  const named = FEATURE_LABELS.filter(([key]) => features[key] === true).map(([, singular]) => singular);

  if (features.paid_count > 0) {
    named.push(features.paid_count === 1 ? 'one ad' : `${features.paid_count} ads`);
  }

  return named;
}

/** "a, b and c" — an Oxford-free list, because this is prose, not a table. */
export function joinPhrases(items: readonly string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0]!;
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

const ordinal = (n: number) => `#${n}`;

/* ══════════════════════════════════════════════════════════════════════════
   The explanation
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Generate the prose from the values, naming the specific blocks responsible.
 *
 * Acceptance criterion 5: "The reconciliation panel explains a real divergence
 * in prose generated from actual stored data, naming the specific SERP features
 * responsible." Every sentence here is conditional on what the data actually
 * says — there is no template that survives contact with missing values.
 */
export function explainReconciliation(gsc: GscSide, targets: readonly SerpSide[]): string[] {
  const lines: string[] = [];

  /* ── The Search Console side ────────────────────────────────────────────── */

  if (gsc.position === null) {
    lines.push(
      gsc.state === 'none'
        ? `Search Console reported nothing for this keyword on ${gsc.date}. That usually means no impressions at all, not a lost ranking.`
        : `Search Console recorded ${gsc.impressions ?? 0} impressions on ${gsc.date} but no position, which is what it returns when nobody saw the result.`,
    );
  } else {
    lines.push(
      `Search Console reports an average position of **${gsc.position.toFixed(1)}** for ${gsc.date}, across ${gsc.impressions ?? 0} impression${gsc.impressions === 1 ? '' : 's'}.`,
    );

    if (gsc.confidence === 'low') {
      lines.push(
        `That average stands on fewer than ${LOW_CONFIDENCE_IMPRESSIONS} impressions, so treat it as noise rather than a reading. It is excluded from alerts for the same reason.`,
      );
    }

    if (gsc.isProvisional) {
      lines.push(
        `It is still provisional — Google revises these figures for a few days, and this one came from ${gsc.state === 'hourly' ? 'partial hourly data' : 'the unfinalised daily feed'}.`,
      );
    }
  }

  /* ── The SERP side ──────────────────────────────────────────────────────── */

  const checked = targets.filter((t) => t.checkedAt !== null);

  if (checked.length === 0) {
    lines.push('No rank check has run near this date, so there is nothing to compare it against yet.');
    return lines;
  }

  for (const target of checked) {
    const where = `${target.locationName} on ${target.device}`;

    // `checked` already excludes never-checked targets, so `found` here is a
    // real boolean. Explicit rather than truthiness, so a future null cannot
    // quietly fall into the "not found" branch again.
    if (target.found === false) {
      lines.push(
        `A check from ${where} did not find the domain in the top 100 at all. That is stored as "not found" with no position — never as position 100, which would drag every average that touches it.`,
      );
      continue;
    }

    if (target.rankGroup !== null && target.rankAbsolute !== null && target.furnitureGap !== null) {
      const features = describeFeatures(target.serpFeatures);

      lines.push(
        `A check from ${where} puts you at organic result **${ordinal(target.rankGroup)}** — but **${ordinal(target.rankAbsolute)}** counting every element on the page.`,
      );

      if (target.furnitureGap > 0) {
        lines.push(
          features.length > 0
            ? `The ${target.furnitureGap}-place gap is ${joinPhrases(features)} sitting above you. Search Console counts those; a human counting blue links does not.`
            : `The ${target.furnitureGap}-place gap is non-organic material above you that Search Console counts and a human counting blue links does not.`,
        );
      } else if (features.length > 0) {
        lines.push(
          `There ${features.length === 1 ? 'is' : 'are'} ${joinPhrases(features)} on this page, but below you — so they cost you nothing here.`,
        );
      }
    } else if (target.rankGroup !== null) {
      lines.push(`A check from ${where} puts you at organic result ${ordinal(target.rankGroup)}.`);
    }
  }

  /* ── What the locations disagree about ──────────────────────────────────── */

  /*
   * The spread between pinned locations is its own signal, not a footnote to
   * the Search Console comparison. requirements.md §6: "The divergence between
   * them is itself a useful signal, and it explains a lot of 'but I saw
   * position 4' conversations." So it gets said whenever it exists, including
   * when one of the locations happens to agree with the average.
   */
  const ranked = checked.filter((t) => t.rankGroup !== null);

  if (ranked.length > 1) {
    const best = ranked.reduce((a, b) => (a.rankGroup! <= b.rankGroup! ? a : b));
    const worst = ranked.reduce((a, b) => (a.rankGroup! >= b.rankGroup! ? a : b));
    const spread = worst.rankGroup! - best.rankGroup!;

    if (spread > 0) {
      lines.push(
        `The locations disagree by ${spread} place${spread === 1 ? '' : 's'}: ${ordinal(best.rankGroup!)} from ${best.locationName} on ${best.device}, ${ordinal(worst.rankGroup!)} from ${worst.locationName} on ${worst.device}. Search Console blends both into one number, which is why neither matches it exactly.`,
      );
    }
  }

  /* ── Why the two still differ ───────────────────────────────────────────── */

  if (gsc.position !== null) {
    const comparable = checked.filter((t) => t.rankAbsolute !== null);

    if (comparable.length > 0) {
      const closest = comparable.reduce((best, t) =>
        Math.abs((t.rankAbsolute ?? 0) - gsc.position!) <
        Math.abs((best.rankAbsolute ?? 0) - gsc.position!)
          ? t
          : best,
      );

      const delta = Math.abs((closest.rankAbsolute ?? 0) - gsc.position);

      lines.push(
        delta <= 2
          ? `The all-elements position (${ordinal(closest.rankAbsolute!)}) lines up with the Search Console average (${gsc.position.toFixed(1)}), which is the expected result — they count the page the same way.`
          : `The two still differ by about ${delta.toFixed(1)} places. Search Console averages every device, location and query variant in the window; the check above is one device at one pinned location at one moment.`,
      );
    }
  }

  return lines;
}

/* ══════════════════════════════════════════════════════════════════════════
   Assembly
   ══════════════════════════════════════════════════════════════════════════ */

export function confidenceOf(impressions: number | null): Confidence {
  if (impressions === null) return 'none';
  return impressions < LOW_CONFIDENCE_IMPRESSIONS ? 'low' : 'normal';
}

/**
 * Build the reconciliation for one keyword on one Pacific date.
 *
 * The GSC point is supplied by the caller — it comes from `getGscSeries`, the
 * single function that owns the precedence rule, so this does not re-derive it.
 */
export async function getReconciliation(
  keywordId: string,
  term: string,
  date: DateString,
  gscPoint: GscSeriesPoint | undefined,
): Promise<Reconciliation> {
  /*
   * "Nearest serp_checks row to that date" (§8), anchored at MIDDAY of the
   * Pacific day rather than midnight. A GSC date covers 24 hours; midnight
   * would make a check at 23:00 look 23 hours away from its own day and pull in
   * the previous day's check instead.
   */
  const anchor = pacificHourToInstant(date, 12);
  const windowStart = pacificHourToInstant(shiftDate(date, -1), 0);
  const windowEnd = pacificHourToInstant(shiftDate(date, 2), 0);

  const rows = await db
    .select({
      keywordTargetId: keywordTargets.id,
      locationName: keywordTargets.locationName,
      device: keywordTargets.device,
      checkedAt: serpChecks.checkedAt,
      found: serpChecks.found,
      rankGroup: serpChecks.rankGroup,
      rankAbsolute: serpChecks.rankAbsolute,
      rankingUrl: serpChecks.rankingUrl,
      serpFeatures: serpChecks.serpFeatures,
      distance: sql<number>`abs(extract(epoch from (${serpChecks.checkedAt} - ${anchor.toISOString()}::timestamptz)))`,
    })
    .from(keywordTargets)
    .leftJoin(
      serpChecks,
      and(
        eq(serpChecks.keywordTargetId, keywordTargets.id),
        sql`${serpChecks.checkedAt} >= ${windowStart.toISOString()}::timestamptz`,
        sql`${serpChecks.checkedAt} < ${windowEnd.toISOString()}::timestamptz`,
      ),
    )
    .where(and(eq(keywordTargets.keywordId, keywordId), eq(keywordTargets.isActive, true)))
    .orderBy(keywordTargets.locationName);

  // One SERP side per target: the nearest check within the window, or none.
  const byTarget = new Map<string, SerpSide>();

  for (const row of rows) {
    const existing = byTarget.get(row.keywordTargetId);

    const candidateDistance = row.checkedAt === null ? Number.POSITIVE_INFINITY : Number(row.distance);
    const existingDistance =
      existing?.hoursFromDate === null || existing === undefined
        ? Number.POSITIVE_INFINITY
        : existing.hoursFromDate * 3600;

    if (existing && candidateDistance >= existingDistance) continue;

    const rankGroup = row.rankGroup;
    const rankAbsolute = row.rankAbsolute;

    byTarget.set(row.keywordTargetId, {
      source: 'Live rank check',
      keywordTargetId: row.keywordTargetId,
      locationName: row.locationName,
      device: row.device,
      checkedAt: row.checkedAt,
      found: row.found,
      rankGroup,
      rankAbsolute,
      furnitureGap:
        rankGroup !== null && rankAbsolute !== null ? rankAbsolute - rankGroup : null,
      serpFeatures: (row.serpFeatures as SerpFeatures | null) ?? null,
      rankingUrl: row.rankingUrl,
      hoursFromDate: row.checkedAt === null ? null : Number(row.distance) / 3600,
    });
  }

  /*
   * `positionImpressions`, not `impressions` — and the resolver's own verdict,
   * not a second evaluation of domain rule 6.
   *
   * For an hourly aggregate the two counts differ: `impressions` is the day's
   * total, `positionImpressions` is the impressions actually behind the
   * average (only the hours that HAD a position). Judging confidence on the
   * day total called a 2-impression average "normal" in this panel while the
   * keyword table, reading the resolver, flagged the same number as noise.
   * Rule 6 now has one definition, in the same place rule 3 lives.
   */
  const gsc: GscSide = {
    source: 'Search Console average position',
    date,
    position: gscPoint?.position ?? null,
    impressions: gscPoint?.positionImpressions ?? null,
    clicks: gscPoint?.clicks ?? null,
    state: gscPoint?.source ?? 'none',
    isProvisional: gscPoint?.isProvisional ?? false,
    confidence:
      gscPoint === undefined || gscPoint.source === 'none'
        ? 'none'
        : gscPoint.isLowConfidence
          ? 'low'
          : 'normal',
  };

  const targets = [...byTarget.values()].sort((a, b) =>
    a.locationName.localeCompare(b.locationName),
  );

  return { keywordId, term, date, gsc, targets, explanation: explainReconciliation(gsc, targets) };
}

/** Exported for the tests that pin the numeric parsing boundary. */
export { toNumber };
