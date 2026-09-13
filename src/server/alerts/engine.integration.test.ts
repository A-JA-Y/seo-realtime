import { randomUUID } from 'node:crypto';

import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/server/db';
import {
  alerts,
  dailyRankRollups,
  keywordTargets,
  keywords,
  organizations,
  properties,
  serpChecks,
} from '@/server/db/schema';
import { runAlertsForProperty, BASELINE_DAYS } from './engine';
import { MIN_CHECKS_PER_DAY } from './rules';

const hasDb = Boolean(process.env.TEST_DATABASE_URL);

const TODAY = '2026-09-12';
const BASELINE = '2026-09-05';

describe.skipIf(!hasDb)('alert engine', () => {
  let orgId: string;
  let propertyId: string;
  let keywordId: string;
  let targetId: string;

  beforeAll(async () => {
    const slug = `alerts-${randomUUID().slice(0, 8)}`;
    const [org] = await db.insert(organizations).values({ name: 'Alerts', slug }).returning();
    orgId = org!.id;

    const [property] = await db
      .insert(properties)
      .values({
        orgId,
        name: 'Alerts Property',
        domain: 'example.com',
        gscSiteUrl: `https://${slug}.example.com/`,
        gscPropertyType: 'url_prefix',
        timezone: 'Asia/Kolkata',
      })
      .returning();
    propertyId = property!.id;

    const [keyword] = await db
      .insert(keywords)
      .values({ propertyId, term: 'alert keyword' })
      .returning();
    keywordId = keyword!.id;

    const [target] = await db
      .insert(keywordTargets)
      .values({
        keywordId,
        propertyId,
        locationCode: 1007742,
        locationName: 'Noida',
        device: 'mobile',
      })
      .returning();
    targetId = target!.id;
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  beforeEach(async () => {
    await db.delete(alerts).where(eq(alerts.propertyId, propertyId));
    await db.delete(dailyRankRollups).where(eq(dailyRankRollups.keywordTargetId, targetId));
    await db.delete(serpChecks).where(eq(serpChecks.keywordTargetId, targetId));
  });

  async function rollup(day: string, best: number | null, checks = 4, found?: number) {
    await db.insert(dailyRankRollups).values({
      keywordTargetId: targetId,
      day,
      bestRankGroup: best,
      worstRankGroup: best,
      bestRankAbsolute: best === null ? null : best + 2,
      checksCount: checks,
      foundCount: found ?? (best === null ? 0 : checks),
    });
  }

  const openAlerts = () =>
    db
      .select()
      .from(alerts)
      .where(and(eq(alerts.propertyId, propertyId), isNull(alerts.resolvedAt)));

  it('raises nothing when there are no rollups at all', async () => {
    const result = await runAlertsForProperty(propertyId);
    expect(result.raised).toBe(0);
    expect(await openAlerts()).toHaveLength(0);
  });

  it('raises a drop from the rollup baseline, not from a single check', async () => {
    await rollup(BASELINE, 4);
    await rollup(TODAY, 40);

    const result = await runAlertsForProperty(propertyId, { day: TODAY });

    expect(result.targetsEvaluated).toBe(1);
    const rows = await openAlerts();
    expect(rows.map((r) => r.type).sort()).toEqual(['lost_top_10', 'rank_drop']);
  });

  /*
   * The property this whole design exists for. A condition that persists for a
   * fortnight has to arrive as one alert, not fourteen — the partial unique
   * index on `signature WHERE resolved_at IS NULL` is what makes the repeat a
   * no-op insert rather than a read-then-act race.
   */
  it('is idempotent: re-running the same day raises nothing new', async () => {
    await rollup(BASELINE, 4);
    await rollup(TODAY, 40);

    const first = await runAlertsForProperty(propertyId, { day: TODAY });
    const second = await runAlertsForProperty(propertyId, { day: TODAY });
    const third = await runAlertsForProperty(propertyId, { day: TODAY });

    expect(first.raised).toBe(2);
    expect(second.raised).toBe(0);
    expect(second.suppressed).toBe(2);
    expect(third.raised).toBe(0);
    expect(await openAlerts()).toHaveLength(2);
  });

  it('resolves an alert when its condition clears, and can raise it again after', async () => {
    await rollup(BASELINE, 4);
    await rollup(TODAY, 40);
    await runAlertsForProperty(propertyId, { day: TODAY });

    expect((await openAlerts()).some((a) => a.type === 'lost_top_10')).toBe(true);

    // Recovered: back inside the top ten a week later.
    await rollup('2026-09-19', 6);
    const recovery = await runAlertsForProperty(propertyId, { day: '2026-09-19' });

    expect(recovery.resolved).toBeGreaterThan(0);
    expect((await openAlerts()).some((a) => a.type === 'lost_top_10')).toBe(false);

    // And falls out again. The freed signature must allow a fresh alert.
    await rollup('2026-09-26', 30);
    await runAlertsForProperty(propertyId, { day: '2026-09-26' });

    expect((await openAlerts()).some((a) => a.type === 'lost_top_10')).toBe(true);
  });

  /*
   * Found by running the engine over demo data out of order.
   *
   * Re-running an OLDER day used to resolve alerts raised from a NEWER one,
   * freeing their signatures — so the next forward run raised the same ongoing
   * conditions again as if they were new. Anyone backfilling a week would have
   * re-notified every open problem.
   */
  it('an older re-run cannot resolve an alert raised from a newer day', async () => {
    await rollup(BASELINE, 4);
    await rollup(TODAY, 40);
    await runAlertsForProperty(propertyId, { day: TODAY });

    const before = await openAlerts();
    expect(before.length).toBe(2);

    // An older day on which the keyword was comfortably inside the top ten.
    await rollup('2026-08-29', 3);
    await rollup('2026-08-22', 3);
    const older = await runAlertsForProperty(propertyId, { day: '2026-08-29' });

    expect(older.resolved).toBe(0);
    expect(await openAlerts()).toHaveLength(before.length);
  });

  /*
   * §9: never alert on a single check. A rollup built from one check IS that
   * check, so the gate has to look at `checks_count`, not merely at the fact
   * that a rollup row exists.
   */
  it('says nothing about a day that rests on a single check', async () => {
    await rollup(BASELINE, 4);
    await rollup(TODAY, null, MIN_CHECKS_PER_DAY - 1, 0);

    const result = await runAlertsForProperty(propertyId, { day: TODAY });

    expect(result.raised).toBe(0);
    expect(await openAlerts()).toHaveLength(0);
  });

  it('raises "lost from the index" only when every check that day missed', async () => {
    await rollup(BASELINE, 12);
    await rollup(TODAY, null, 4, 0);

    await runAlertsForProperty(propertyId, { day: TODAY });
    const rows = await openAlerts();

    const lost = rows.find((r) => r.type === 'lost_from_index');
    expect(lost).toBeDefined();
    expect(lost?.severity).toBe('critical');
    // Domain rule 5, restated where the reader will see it.
    expect(lost?.body).toMatch(/never as position 100/);
  });

  it('does not raise "lost from the index" when one check that day found it', async () => {
    await rollup(BASELINE, 12);
    await rollup(TODAY, 80, 4, 1);

    await runAlertsForProperty(propertyId, { day: TODAY });
    expect((await openAlerts()).some((r) => r.type === 'lost_from_index')).toBe(false);
  });

  it('picks the baseline exactly BASELINE_DAYS back', async () => {
    await rollup(TODAY, 40);
    // A rollup one day off the baseline must not be used as one.
    await rollup('2026-09-06', 4);

    const noBaseline = await runAlertsForProperty(propertyId, { day: TODAY });
    expect(noBaseline.raised).toBe(0);

    await rollup(BASELINE, 4);
    const withBaseline = await runAlertsForProperty(propertyId, { day: TODAY });
    expect(withBaseline.raised).toBeGreaterThan(0);
    expect(BASELINE_DAYS).toBe(7);
  });

  /*
   * The two event signals — the ranking-URL swap and the new top-3 competitor —
   * are the only parts of the engine that read `serp_checks` rather than the
   * rollups, and they were exercised by nothing. Deleting either query would
   * have left the suite green.
   */
  describe('event signals, which read checks rather than rollups', () => {
    async function check(at: string, rankingUrl: string | null, competitors: string[]) {
      await db.insert(serpChecks).values({
        keywordTargetId: targetId,
        propertyId,
        keywordId,
        checkedAt: new Date(at),
        found: rankingUrl !== null,
        rankGroup: rankingUrl === null ? null : 5,
        rankAbsolute: rankingUrl === null ? null : 8,
        rankingUrl,
        competingDomains: competitors.map((domain, i) => ({
          rank_group: i + 1,
          domain,
          url: `https://${domain}/x`,
          title: domain,
        })),
        costUsd: '0.000600',
      });
    }

    // The engine buckets checks by the PROPERTY timezone (Asia/Kolkata here),
    // so these instants are chosen to land on the intended local days.
    const onBaselineDay = '2026-09-05T06:00:00Z';
    const onToday = '2026-09-12T06:00:00Z';

    it('raises when Google swaps which of your pages ranks', async () => {
      await rollup(BASELINE, 5);
      await rollup(TODAY, 5);
      await check(onBaselineDay, 'https://example.com/old', ['a.com']);
      await check(onToday, 'https://example.com/new', ['a.com']);

      await runAlertsForProperty(propertyId, { day: TODAY });
      const rows = await openAlerts();

      const swap = rows.find((r) => r.type === 'ranking_url_changed');
      expect(swap, 'a URL swap at an unchanged position must still alert').toBeDefined();
      expect(swap?.body).toContain('/old');
      expect(swap?.body).toContain('/new');
    });

    it('does not raise a URL change when the page is the same', async () => {
      await rollup(BASELINE, 5);
      await rollup(TODAY, 5);
      await check(onBaselineDay, 'https://example.com/same', ['a.com']);
      await check(onToday, 'https://example.com/same', ['a.com']);

      await runAlertsForProperty(propertyId, { day: TODAY });
      expect((await openAlerts()).some((r) => r.type === 'ranking_url_changed')).toBe(false);
    });

    /*
     * Domain rule 7's sibling case: dropping out and coming back on the same
     * page is not a URL swap. A not-found check has no ranking URL, and
     * treating that as a change reports a different event with a different
     * cause.
     */
    it('does not report dropping out and returning as a URL change', async () => {
      await rollup(BASELINE, 5);
      await rollup(TODAY, 5);
      await check(onBaselineDay, 'https://example.com/same', ['a.com']);
      await check('2026-09-12T02:00:00Z', null, []);
      await check(onToday, 'https://example.com/same', ['a.com']);

      await runAlertsForProperty(propertyId, { day: TODAY });
      expect((await openAlerts()).some((r) => r.type === 'ranking_url_changed')).toBe(false);
    });

    it('raises for a domain that entered the top 3', async () => {
      await rollup(BASELINE, 5);
      await rollup(TODAY, 5);
      await check(onBaselineDay, 'https://example.com/p', ['a.com', 'b.com', 'c.com']);
      await check(onToday, 'https://example.com/p', ['a.com', 'rival.com', 'c.com']);

      await runAlertsForProperty(propertyId, { day: TODAY });
      const rows = await openAlerts();

      const entered = rows.filter((r) => r.type === 'new_competitor_top_3');
      expect(entered.map((r) => r.title).join(' ')).toContain('rival.com');
      // The domains that were already there are not news.
      expect(entered.map((r) => r.title).join(' ')).not.toContain('a.com');
    });

    it('does not raise for a domain that was already in the top 3', async () => {
      await rollup(BASELINE, 5);
      await rollup(TODAY, 5);
      await check(onBaselineDay, 'https://example.com/p', ['a.com', 'b.com', 'c.com']);
      await check(onToday, 'https://example.com/p', ['a.com', 'b.com', 'c.com']);

      /*
       * State the precondition before the negative assertion.
       *
       * "No alert was raised" is true for many reasons, most of them bugs — the
       * query found no baseline row, the day bucketing landed elsewhere, the
       * rows were not there at all. Checking that BOTH days are present and
       * identical first means a failure says which half broke rather than
       * merely that something did. (This assertion failed once in a full-suite
       * run and never again in five; it is now diagnosable if it recurs.)
       */
      const days = await db.execute<{ day: string; n: number }>(sql`
        SELECT (sc.checked_at AT TIME ZONE p.timezone)::date::text AS day, count(*)::int AS n
        FROM serp_checks sc
        JOIN properties p ON p.id = sc.property_id
        WHERE sc.keyword_target_id = ${targetId}::uuid
        GROUP BY 1 ORDER BY 1
      `);
      expect(days.rows.map((r) => r.day)).toEqual([BASELINE, TODAY]);

      await runAlertsForProperty(propertyId, { day: TODAY });

      const raised = (await openAlerts()).filter((r) => r.type === 'new_competitor_top_3');
      expect(raised.map((r) => r.title)).toEqual([]);
    });
  });

  it('records an ingest run so /ops can see the engine is alive', async () => {
    await rollup(BASELINE, 4);
    await rollup(TODAY, 40);
    await runAlertsForProperty(propertyId, { day: TODAY });

    const runs = await db.execute<{ status: string; rows_written: number; meta: unknown }>(sql`
      SELECT status, rows_written, meta FROM ingest_runs
      WHERE kind = 'alerts' AND property_id = ${propertyId}::uuid
      ORDER BY started_at DESC LIMIT 1
    `);

    expect(runs.rows[0]?.status).toBe('success');
    expect(runs.rows[0]?.rows_written).toBe(2);
  });

  it('scopes to one property: another tenant\u2019s rollups raise nothing here', async () => {
    const [other] = await db
      .insert(organizations)
      .values({ name: 'Other', slug: `other-${randomUUID().slice(0, 8)}` })
      .returning();

    const [otherProperty] = await db
      .insert(properties)
      .values({
        orgId: other!.id,
        name: 'Other Property',
        domain: 'other.example',
        gscSiteUrl: 'https://other.example/',
        gscPropertyType: 'url_prefix',
        timezone: 'Asia/Kolkata',
      })
      .returning();

    await rollup(BASELINE, 4);
    await rollup(TODAY, 40);

    const result = await runAlertsForProperty(otherProperty!.id, { day: TODAY });

    expect(result.targetsEvaluated).toBe(0);
    expect(result.raised).toBe(0);

    await db.delete(organizations).where(eq(organizations.id, other!.id));
  });
});
