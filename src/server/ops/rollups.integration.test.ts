import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/server/db';
import {
  dailyRankRollups,
  keywordTargets,
  keywords,
  organizations,
  properties,
  serpChecks,
} from '@/server/db/schema';
import { buildDailyRollups, runRollupJob } from './rollups';

const hasDb = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!hasDb)('daily rank rollups', () => {
  let orgId: string;
  let propertyId: string;
  let keywordId: string;
  let targetId: string;

  beforeAll(async () => {
    const slug = `rollup-${randomUUID().slice(0, 8)}`;
    const [org] = await db.insert(organizations).values({ name: 'Rollup', slug }).returning();
    orgId = org!.id;

    const [property] = await db
      .insert(properties)
      .values({
        orgId,
        name: 'Rollup Property',
        domain: 'example.com',
        gscSiteUrl: `https://${slug}.example.com/`,
        gscPropertyType: 'url_prefix',
        timezone: 'Asia/Kolkata',
      })
      .returning();
    propertyId = property!.id;

    const [keyword] = await db
      .insert(keywords)
      .values({ propertyId, term: 'rollup keyword' })
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
    if (orgId) await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  beforeEach(async () => {
    await db.delete(serpChecks).where(eq(serpChecks.propertyId, propertyId));
    await db.delete(dailyRankRollups).where(eq(dailyRankRollups.keywordTargetId, targetId));
  });

  /** Insert a check at an exact instant. */
  const check = (iso: string, fields: { found: boolean; rankGroup?: number; rankAbsolute?: number }) =>
    db.insert(serpChecks).values({
      keywordTargetId: targetId,
      propertyId,
      keywordId,
      checkedAt: new Date(iso),
      found: fields.found,
      rankGroup: fields.rankGroup ?? null,
      rankAbsolute: fields.rankAbsolute ?? null,
      costUsd: '0.000600',
    });

  const rollupFor = async (day: string) => {
    const [row] = await db
      .select()
      .from(dailyRankRollups)
      .where(and(eq(dailyRankRollups.keywordTargetId, targetId), eq(dailyRankRollups.day, day)));
    return row;
  };

  const window = { from: '2026-09-01', to: '2026-09-30' };

  it('computes best, worst and average from the day\'s checks', async () => {
    await check('2026-09-12T04:00:00Z', { found: true, rankGroup: 7, rankAbsolute: 13 });
    await check('2026-09-12T08:00:00Z', { found: true, rankGroup: 4, rankAbsolute: 9 });
    await check('2026-09-12T12:00:00Z', { found: true, rankGroup: 10, rankAbsolute: 17 });

    await buildDailyRollups(window);
    const row = await rollupFor('2026-09-12');

    // Best rank is the LOWEST number — position 4 beats position 10.
    expect(row!.bestRankGroup).toBe(4);
    expect(row!.worstRankGroup).toBe(10);
    expect(Number(row!.avgRankGroup)).toBeCloseTo(7, 2);
    expect(row!.bestRankAbsolute).toBe(9);
    expect(row!.checksCount).toBe(3);
    expect(row!.foundCount).toBe(3);
  });

  it('counts a miss in checks_count but NOT in the rank aggregates', async () => {
    // Domain rule 5's principle at the aggregate level: a not-found check has
    // no position, and inventing one (100, say) would drag every average.
    await check('2026-09-12T04:00:00Z', { found: true, rankGroup: 4, rankAbsolute: 9 });
    await check('2026-09-12T08:00:00Z', { found: false });

    await buildDailyRollups(window);
    const row = await rollupFor('2026-09-12');

    expect(row!.checksCount).toBe(2);
    expect(row!.foundCount).toBe(1);
    expect(row!.bestRankGroup).toBe(4);
    expect(Number(row!.avgRankGroup)).toBeCloseTo(4, 2); // not (4+100)/2
  });

  it('leaves every rank aggregate NULL for a day of pure misses', async () => {
    await check('2026-09-12T04:00:00Z', { found: false });
    await check('2026-09-12T08:00:00Z', { found: false });

    await buildDailyRollups(window);
    const row = await rollupFor('2026-09-12');

    expect(row!.checksCount).toBe(2);
    expect(row!.foundCount).toBe(0);
    expect(row!.bestRankGroup).toBeNull();
    expect(row!.avgRankGroup).toBeNull();
  });

  it('groups by the PROPERTY timezone, not UTC', async () => {
    // 19:00 UTC is 00:30 the NEXT day in IST. Grouping by UTC would split
    // every Indian evening across two rollup rows, and "moved today" would
    // stop meaning what the client means by today.
    await check('2026-09-12T19:00:00Z', { found: true, rankGroup: 5, rankAbsolute: 11 });

    await buildDailyRollups(window);

    expect(await rollupFor('2026-09-13')).toBeDefined();
    expect(await rollupFor('2026-09-12')).toBeUndefined();
  });

  it('is idempotent — re-running updates in place', async () => {
    await check('2026-09-12T04:00:00Z', { found: true, rankGroup: 7, rankAbsolute: 13 });

    await buildDailyRollups(window);
    await buildDailyRollups(window);

    const rows = await db
      .select()
      .from(dailyRankRollups)
      .where(eq(dailyRankRollups.keywordTargetId, targetId));

    expect(rows).toHaveLength(1);
  });

  it('picks up a late-arriving check on the next run', async () => {
    // A pingback for yesterday that arrived after the rollup ran must not be
    // stranded outside the series.
    await check('2026-09-12T04:00:00Z', { found: true, rankGroup: 7, rankAbsolute: 13 });
    await buildDailyRollups(window);

    await check('2026-09-12T05:00:00Z', { found: true, rankGroup: 3, rankAbsolute: 8 });
    await buildDailyRollups(window);

    const row = await rollupFor('2026-09-12');
    expect(row!.checksCount).toBe(2);
    expect(row!.bestRankGroup).toBe(3);
  });

  it('separates distinct days', async () => {
    await check('2026-09-11T06:00:00Z', { found: true, rankGroup: 9, rankAbsolute: 15 });
    await check('2026-09-12T06:00:00Z', { found: true, rankGroup: 4, rankAbsolute: 9 });

    await buildDailyRollups(window);

    expect((await rollupFor('2026-09-11'))!.bestRankGroup).toBe(9);
    expect((await rollupFor('2026-09-12'))!.bestRankGroup).toBe(4);
  });

  it('ignores checks outside the requested window', async () => {
    await check('2026-08-01T06:00:00Z', { found: true, rankGroup: 9, rankAbsolute: 15 });
    await buildDailyRollups(window);
    expect(await rollupFor('2026-08-01')).toBeUndefined();
  });

  it('records an ingest_runs row when run as a job', async () => {
    await check('2026-09-12T04:00:00Z', { found: true, rankGroup: 7, rankAbsolute: 13 });

    const result = await runRollupJob(window);
    expect(result.daysWritten).toBeGreaterThan(0);

    const [run] = (
      await db.execute<{ status: string; rows_written: number }>(
        sql`SELECT status, rows_written FROM ingest_runs WHERE kind = 'rollup' ORDER BY started_at DESC LIMIT 1`,
      )
    ).rows;

    expect(run!.status).toBe('success');
    expect(run!.rows_written).toBeGreaterThan(0);
  });
});
