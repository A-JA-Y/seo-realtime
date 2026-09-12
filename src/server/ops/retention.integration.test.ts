import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/server/db';
import {
  dailyRankRollups,
  gscSnapshots,
  keywordTargets,
  keywords,
  organizations,
  properties,
  serpChecks,
  serpPayloads,
} from '@/server/db/schema';
import { buildDailyRollups } from './rollups';
import {
  CHECK_RETENTION_DAYS,
  GSC_HOURLY_RETENTION_DAYS,
  PAYLOAD_RETENTION_DAYS,
  pruneGscHourly,
  pruneSerpChecks,
  pruneSerpPayloads,
  runPruneJob,
} from './retention';

const hasDb = Boolean(process.env.TEST_DATABASE_URL);

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
const dateDaysAgo = (n: number) => daysAgo(n).toISOString().slice(0, 10);

describe.skipIf(!hasDb)('retention', () => {
  let orgId: string;
  let propertyId: string;
  let keywordId: string;
  let targetId: string;

  beforeAll(async () => {
    const slug = `prune-${randomUUID().slice(0, 8)}`;
    const [org] = await db.insert(organizations).values({ name: 'Prune', slug }).returning();
    orgId = org!.id;

    const [property] = await db
      .insert(properties)
      .values({
        orgId,
        name: 'Prune Property',
        domain: 'example.com',
        gscSiteUrl: `https://${slug}.example.com/`,
        gscPropertyType: 'url_prefix',
        timezone: 'UTC',
      })
      .returning();
    propertyId = property!.id;

    const [keyword] = await db.insert(keywords).values({ propertyId, term: 'prune kw' }).returning();
    keywordId = keyword!.id;

    const [target] = await db
      .insert(keywordTargets)
      .values({ keywordId, propertyId, locationCode: 2356, locationName: 'India', device: 'desktop' })
      .returning();
    targetId = target!.id;
  });

  afterAll(async () => {
    if (orgId) await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  beforeEach(async () => {
    await db.delete(serpChecks).where(eq(serpChecks.propertyId, propertyId));
    await db.delete(gscSnapshots).where(eq(gscSnapshots.propertyId, propertyId));
    await db.delete(dailyRankRollups).where(eq(dailyRankRollups.keywordTargetId, targetId));
  });

  async function insertCheck(ageDays: number) {
    const [row] = await db
      .insert(serpChecks)
      .values({
        keywordTargetId: targetId,
        propertyId,
        keywordId,
        checkedAt: daysAgo(ageDays),
        found: true,
        rankGroup: 7,
        rankAbsolute: 13,
        costUsd: '0.000600',
      })
      .returning({ id: serpChecks.id });
    return row!.id;
  }

  const countChecks = async () => {
    const [r] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(serpChecks)
      .where(eq(serpChecks.propertyId, propertyId));
    return r?.n ?? 0;
  };

  /* ── Payloads ─────────────────────────────────────────────────────────── */

  describe('pruneSerpPayloads', () => {
    it('deletes payloads past the retention window and keeps recent ones', async () => {
      const oldId = await insertCheck(5);
      const newId = await insertCheck(1);

      await db.insert(serpPayloads).values([
        { serpCheckId: oldId, payload: { a: 1 }, createdAt: daysAgo(PAYLOAD_RETENTION_DAYS + 5) },
        { serpCheckId: newId, payload: { a: 2 }, createdAt: daysAgo(1) },
      ]);

      const deleted = await pruneSerpPayloads();
      expect(deleted).toBeGreaterThanOrEqual(1);

      const remaining = await db
        .select()
        .from(serpPayloads)
        .where(eq(serpPayloads.serpCheckId, oldId));
      expect(remaining).toHaveLength(0);

      // The time series itself is untouched — payloads live apart precisely so
      // they can be pruned without it.
      expect(await countChecks()).toBe(2);
    });
  });

  /* ── Checks — the safety guard is the point ───────────────────────────── */

  describe('pruneSerpChecks', () => {
    it('REFUSES to delete a day that has no rollup', async () => {
      // The whole safety property. If the rollup job has been failing silently
      // for a fortnight, deleting here would destroy the only remaining copy
      // of three months of rank history.
      await insertCheck(CHECK_RETENTION_DAYS + 10);

      const deleted = await pruneSerpChecks();

      expect(deleted).toBe(0);
      expect(await countChecks()).toBe(1);
    });

    it('deletes an old check once its day is rolled up', async () => {
      const age = CHECK_RETENTION_DAYS + 10;
      await insertCheck(age);

      await buildDailyRollups({ from: dateDaysAgo(age + 1), to: dateDaysAgo(age - 1) });
      expect(
        await db.select().from(dailyRankRollups).where(eq(dailyRankRollups.keywordTargetId, targetId)),
      ).toHaveLength(1);

      const deleted = await pruneSerpChecks();

      expect(deleted).toBe(1);
      expect(await countChecks()).toBe(0);

      // The rollup survives: the series still renders for that day.
      expect(
        await db.select().from(dailyRankRollups).where(eq(dailyRankRollups.keywordTargetId, targetId)),
      ).toHaveLength(1);
    });

    it('keeps checks inside the retention window even when rolled up', async () => {
      await insertCheck(30);
      await buildDailyRollups({ from: dateDaysAgo(31), to: dateDaysAgo(29) });

      expect(await pruneSerpChecks()).toBe(0);
      expect(await countChecks()).toBe(1);
    });

    it('cascades the payload away with the check', async () => {
      const age = CHECK_RETENTION_DAYS + 10;
      const id = await insertCheck(age);
      await db.insert(serpPayloads).values({ serpCheckId: id, payload: {} });
      await buildDailyRollups({ from: dateDaysAgo(age + 1), to: dateDaysAgo(age - 1) });

      await pruneSerpChecks();

      expect(await db.select().from(serpPayloads).where(eq(serpPayloads.serpCheckId, id))).toHaveLength(0);
    });
  });

  /* ── GSC hourly ───────────────────────────────────────────────────────── */

  describe('pruneGscHourly', () => {
    const insertSnapshot = (
      date: string,
      state: 'hourly' | 'final',
      hour: number | null,
    ) =>
      db.insert(gscSnapshots).values({
        propertyId,
        keywordId,
        gscDate: date,
        gscHour: hour,
        dataState: state,
        clicks: 1,
        impressions: 10,
        ctr: '0.1',
        position: '7.50',
      });

    it('REFUSES to delete hourly rows for a date with no settled figure', async () => {
      // Otherwise a date whose reconciliation never ran loses everything and
      // renders as a permanent gap that looks like "no impressions".
      const date = dateDaysAgo(GSC_HOURLY_RETENTION_DAYS + 10);
      await insertSnapshot(date, 'hourly', 9);

      expect(await pruneGscHourly()).toBe(0);

      const [remaining] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(gscSnapshots)
        .where(and(eq(gscSnapshots.keywordId, keywordId), eq(gscSnapshots.dataState, 'hourly')));
      expect(remaining!.n).toBe(1);
    });

    it('deletes hourly rows once the date has a final row', async () => {
      const date = dateDaysAgo(GSC_HOURLY_RETENTION_DAYS + 10);
      await insertSnapshot(date, 'hourly', 9);
      await insertSnapshot(date, 'hourly', 14);
      await insertSnapshot(date, 'final', null);

      expect(await pruneGscHourly()).toBe(2);

      const rows = await db
        .select()
        .from(gscSnapshots)
        .where(eq(gscSnapshots.keywordId, keywordId));

      // The settled figure survives, so getGscSeries still resolves the date.
      expect(rows).toHaveLength(1);
      expect(rows[0]!.dataState).toBe('final');
    });

    it('keeps recent hourly rows even when settled', async () => {
      const date = dateDaysAgo(2);
      await insertSnapshot(date, 'hourly', 9);
      await insertSnapshot(date, 'final', null);

      expect(await pruneGscHourly()).toBe(0);
    });

    it('never touches fresh or final rows', async () => {
      const date = dateDaysAgo(GSC_HOURLY_RETENTION_DAYS + 10);
      await insertSnapshot(date, 'final', null);

      await pruneGscHourly();

      expect(await db.select().from(gscSnapshots).where(eq(gscSnapshots.keywordId, keywordId))).toHaveLength(1);
    });
  });

  /* ── The job ──────────────────────────────────────────────────────────── */

  describe('runPruneJob', () => {
    it('rolls up BEFORE pruning, so old checks are deletable in one pass', async () => {
      // Order is the whole design. Pruning first would leave the checks
      // undeleted (the guard sees to that) and storage would never shrink.
      const age = CHECK_RETENTION_DAYS + 10;
      await insertCheck(age);

      const result = await runPruneJob();

      expect(result.rollupsWritten).toBeGreaterThan(0);
      expect(result.checksDeleted).toBeGreaterThanOrEqual(1);
      expect(await countChecks()).toBe(0);
    });

    it('rolls up checks of ANY age, so nothing becomes immortal', async () => {
      /*
       * The subtle failure this guards: if the pre-prune rollup has a lower
       * bound, a check older than it never gets a rollup — and pruneSerpChecks
       * refuses to delete an unrolled day, so the row can never be deleted
       * either. It accumulates forever, which is the opposite of the job's
       * purpose. A two-year-old check must still be rolled up and removed.
       */
      await insertCheck(CHECK_RETENTION_DAYS + 640);

      const result = await runPruneJob();

      expect(result.checksDeleted).toBeGreaterThanOrEqual(1);
      expect(await countChecks()).toBe(0);
    });

    it('records an ingest_runs row', async () => {
      await runPruneJob();

      const [run] = (
        await db.execute<{ status: string }>(
          sql`SELECT status FROM ingest_runs WHERE kind = 'prune' ORDER BY started_at DESC LIMIT 1`,
        )
      ).rows;

      expect(['success', 'partial']).toContain(run!.status);
    });
  });
});
