/**
 * Synthetic demo data.
 *
 *   pnpm db:demo          fill the seeded property with a 28-day history
 *   pnpm db:demo --clear  remove it again
 *   /api/cron/bootstrap-demo   the same, against a hosted deployment
 *
 * NOT part of `pnpm db:seed`, and never run against real data: every row here
 * is invented. The hosted job refuses to run unless DEMO_MODE is set, so a
 * production database cannot be filled with fiction by anyone holding the cron
 * secret. It exists so the dashboard can be developed and verified against
 * data with the shapes that actually matter —
 *
 *   - a rank that improves over the window, so the inverted axis is visible
 *   - dates with NO data at all, so the chart must render a gap
 *   - a zero-impression day, so `position` is NULL rather than 0
 *   - a not-found check, so "absent" is not position 100
 *   - rank_group diverging from rank_absolute, so the furniture gap is real
 *   - a ranking URL that changes partway through
 *   - two locations that disagree, which is what the panel has to explain
 */
import { and, eq, inArray, isNull } from 'drizzle-orm';

import { shiftDate, type DateString } from '@/lib/gsc-dates';
import { db } from '@/server/db';
import {
  alerts,
  dailyRankRollups,
  gscSnapshots,
  keywordTargets,
  keywords,
  properties,
  serpChecks,
} from '@/server/db/schema';
import { buildDailyRollups } from '@/server/ops/rollups';
import { runAlertsForProperty } from '@/server/alerts/engine';

const DAYS = 28;
/** Fixed so re-running produces the same history. */
const ANCHOR = '2026-09-12';

const COMPETITORS = [
  '99acres.com',
  'magicbricks.com',
  'housing.com',
  'squareyards.com',
  'nobroker.in',
  'proptiger.com',
  'commonfloor.com',
  'makaan.com',
];

/** Deterministic pseudo-random in [0,1), so the demo is reproducible. */
function rand(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Remove everything this script writes, and everything derived from it.
 *
 * Rollups and alerts are not written here, but they are computed FROM what is
 * written here — so leaving them behind leaves a database that still shows
 * synthetic movement after the synthetic checks are gone, with no way to tell
 * it apart from real history. `--clear` has to mean cleared.
 *
 * Rollups cascade from keyword_targets, not from serp_checks, so deleting the
 * checks does not take them with it.
 */
export async function clearDemoData(propertyId: string): Promise<void> {
  const targets = await db
    .select({ id: keywordTargets.id })
    .from(keywordTargets)
    .where(eq(keywordTargets.propertyId, propertyId));

  const ids = targets.map((t) => t.id);

  if (ids.length > 0) {
    await db.delete(dailyRankRollups).where(inArray(dailyRankRollups.keywordTargetId, ids));
  }

  await db.delete(alerts).where(eq(alerts.propertyId, propertyId));
  await db.delete(serpChecks).where(eq(serpChecks.propertyId, propertyId));
  await db.delete(gscSnapshots).where(eq(gscSnapshots.propertyId, propertyId));

}

export interface DemoResult {
  property: { id: string; name: string };
  gscRows: number;
  checkRows: number;
  rollups: number;
  alertsRaised: number;
  alertsOpen: number;
}

/** The first seeded property, or a clear error naming the fix. */
export async function demoProperty() {
  const [property] = await db.select().from(properties).limit(1);
  if (!property) throw new Error('No property found — run `pnpm db:seed` first.');
  return property;
}

/**
 * Fill the property with a 28-day synthetic history. Idempotent: clears first.
 */
export async function seedDemoData(propertyId: string): Promise<DemoResult> {
  const [property] = await db.select().from(properties).where(eq(properties.id, propertyId));
  if (!property) throw new Error('No such property');

  await clearDemoData(property.id);

  const allKeywords = await db
    .select()
    .from(keywords)
    .where(eq(keywords.propertyId, property.id));

  const allTargets = await db
    .select()
    .from(keywordTargets)
    .where(
      inArray(
        keywordTargets.keywordId,
        allKeywords.map((k) => k.id),
      ),
    );

  let gscRows = 0;
  let checkRows = 0;

  for (const [keywordIndex, keyword] of allKeywords.entries()) {
    /*
     * The headline keyword follows the series the build spec names: roughly
     * 35.0 on 31 Aug improving to 7.8 by 9 Sep. The rest are offset from it so
     * the table has variety.
     */
    const isHeadline = keyword.term === 'prestige sector 150 noida';
    const startPosition = isHeadline ? 35 : 12 + keywordIndex * 3;
    const endPosition = isHeadline ? 7.8 : Math.max(3, startPosition - 4 - keywordIndex);

    /* ── Search Console: one final row per day, with deliberate holes ─────── */

    for (let back = DAYS; back >= 0; back--) {
      const date = shiftDate(ANCHOR as DateString, -back);
      const progress = (DAYS - back) / DAYS;
      const seed = keywordIndex * 100 + back;

      // Two kinds of hole, both of which the chart must render as a GAP:
      // days Google reported nothing, and a day with impressions but no rank.
      const noData = rand(seed) < 0.12;
      if (noData) continue;

      const zeroImpressions = rand(seed + 7) < 0.06;
      const impressions = zeroImpressions ? 0 : Math.round(8 + progress * 120 + rand(seed + 3) * 30);
      const position =
        impressions === 0
          ? null
          : startPosition + (endPosition - startPosition) * progress + (rand(seed + 1) - 0.5) * 3;

      const clicks = impressions === 0 ? 0 : Math.round(impressions * 0.03 * rand(seed + 5));

      await db.insert(gscSnapshots).values({
        propertyId: property.id,
        keywordId: keyword.id,
        gscDate: date,
        gscHour: null,
        dataState: back <= 3 ? 'fresh' : 'final',
        clicks,
        impressions,
        ctr: (impressions === 0 ? 0 : clicks / impressions).toFixed(6),
        // The CHECK constraint enforces position >= 1; clamp rather than
        // generate a row the database would rightly refuse.
        position: position === null ? null : Math.max(1, position).toFixed(2),
      });
      gscRows++;
    }

    /* ── SERP checks: four a day per target ───────────────────────────────── */

    for (const target of allTargets.filter((t) => t.keywordId === keyword.id)) {
      // The city check sees a friendlier SERP than the national one — that
      // divergence is what the reconciliation panel exists to explain.
      const localBonus = target.locationName.startsWith('Noida') ? -3 : 0;

      for (let back = DAYS; back >= 0; back--) {
        for (const hour of [2, 8, 14, 20]) {
          const progress = (DAYS - back) / DAYS;
          const seed = keywordIndex * 1000 + back * 10 + hour + localBonus;

          const checkedAt = new Date(`${shiftDate(ANCHOR as DateString, -back)}T00:00:00Z`);
          checkedAt.setUTCHours(hour);

          // One keyword drops out of the top 100 for a stretch, and is out
          // again right now — so "not found" is exercised both as a gap in the
          // history and as the CURRENT state of a row in the table, which is
          // where a sentinel 100 would otherwise hide.
          const droppedOut = keywordIndex === 4 && (back <= 1 || (back >= 10 && back <= 14));

          if (droppedOut) {
            await db.insert(serpChecks).values({
              keywordTargetId: target.id,
              propertyId: property.id,
              keywordId: keyword.id,
              checkedAt,
              found: false,
              rankGroup: null,
              rankAbsolute: null,
              rankingUrl: null,
              organicResultCount: 100,
              costUsd: '0.000600',
            });
            checkRows++;
            continue;
          }

          const rankGroup = Math.max(
            1,
            Math.round(
              startPosition + (endPosition - startPosition) * progress + localBonus + (rand(seed) - 0.5) * 3,
            ),
          );

          // SERP furniture: more of it on mobile, and an AI Overview appears
          // in the last week — a visibility loss at an unchanged rank.
          const aiOverview = back < 7;
          const localPack = target.device === 'mobile';
          const images = rand(seed + 2) < 0.6;
          const paidCount = rand(seed + 4) < 0.5 ? 2 : 0;

          const furniture =
            (aiOverview ? 1 : 0) + (localPack ? 1 : 0) + (images ? 1 : 0) + paidCount;

          /*
           * ONE keyword's ranking URL changes partway through — domain rule 7.
           *
           * Deliberately one and not all of them. Swapping every URL on the
           * same day is easier to write and produces a wall of 26 identical
           * alerts, which hides whether the detection works at all: the thing
           * worth seeing is one swap standing out among keywords that did not
           * move.
           */
          const swapped = keywordIndex === 2 && back <= 12;
          const rankingUrl = swapped
            ? `https://${property.domain}/${keyword.term.split(' ').slice(-1)[0]}`
            : `https://${property.domain}/`;

          await db.insert(serpChecks).values({
            keywordTargetId: target.id,
            propertyId: property.id,
            keywordId: keyword.id,
            checkedAt,
            found: true,
            rankGroup,
            rankAbsolute: rankGroup + furniture,
            rankingUrl,
            allRankingUrls: [{ rank_group: rankGroup, url: rankingUrl }],
            competingDomains: COMPETITORS.slice(0, 6).map((domain, i) => ({
              rank_group: i + 1,
              domain,
              url: `https://${domain}/listing`,
              title: `${domain} listing`,
            })),
            serpFeatures: {
              ai_overview: aiOverview,
              local_pack: localPack,
              images,
              people_also_ask: rand(seed + 6) < 0.7,
              video: false,
              top_stories: false,
              paid_count: paidCount,
            },
            organicResultCount: 100,
            costUsd: '0.000600',
          });
          checkRows++;
        }
      }

      await db
        .update(keywordTargets)
        .set({ lastCheckedAt: new Date(`${ANCHOR}T20:00:00Z`) })
        .where(eq(keywordTargets.id, target.id));
    }
  }

  const rollups = await buildDailyRollups({
    from: shiftDate(ANCHOR as DateString, -DAYS - 1),
    to: ANCHOR as DateString,
  });

  /*
   * Run the alert engine forward over the seeded window.
   *
   * Not decoration. A demo dataset with an empty alerts feed makes the alerts
   * page impossible to look at and, worse, makes its end-to-end tests skip
   * themselves: the mark-read and resolve specs guard on "is there anything
   * unread", so with no alerts they passed without executing — in CI, every
   * time. A test that is always skipped is a test that is not there.
   *
   * Walking day by day rather than evaluating once also exercises the part
   * that matters: alerts raised on one day, suppressed on the next, and
   * resolved when their condition clears.
   */
  let raised = 0;
  for (let back = DAYS; back >= 0; back--) {
    const day = shiftDate(ANCHOR as DateString, -back);
    raised += (await runAlertsForProperty(property.id, { day })).raised;
  }

  const openAlerts = await db
    .select({ id: alerts.id })
    .from(alerts)
    .where(and(eq(alerts.propertyId, property.id), isNull(alerts.resolvedAt)));

  return {
    property: { id: property.id, name: property.name },
    gscRows,
    checkRows,
    rollups: rollups.daysWritten,
    alertsRaised: raised,
    alertsOpen: openAlerts.length,
  };
}
