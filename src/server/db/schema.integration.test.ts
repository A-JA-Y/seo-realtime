import { randomUUID } from 'node:crypto';

import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db } from './index';
import {
  alerts,
  gscSnapshots,
  keywordTargets,
  keywords,
  organizations,
  properties,
  serpChecks,
} from './schema';

/**
 * Integration tests against a real Postgres. Set TEST_DATABASE_URL to a Neon
 * `dev` branch (or any throwaway instance) with the migration applied:
 *
 *   TEST_DATABASE_URL=postgresql://... pnpm test
 *
 * Skipped entirely when it is absent, so `pnpm test` stays offline by default.
 */
const hasDb = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!hasDb)('schema constraints', () => {
  let orgId: string;
  let propertyId: string;
  let keywordId: string;
  let targetId: string;

  beforeAll(async () => {
    const slug = `test-${randomUUID().slice(0, 8)}`;

    const [org] = await db.insert(organizations).values({ name: 'Test Org', slug }).returning();
    orgId = org!.id;

    const [property] = await db
      .insert(properties)
      .values({
        orgId,
        name: 'Test Property',
        domain: 'example.com',
        gscSiteUrl: `https://${slug}.example.com/`,
        gscPropertyType: 'url_prefix',
      })
      .returning();
    propertyId = property!.id;

    const [keyword] = await db
      .insert(keywords)
      .values({ propertyId, term: 'test keyword', isPrimary: true })
      .returning();
    keywordId = keyword!.id;

    const [target] = await db
      .insert(keywordTargets)
      .values({
        keywordId,
        propertyId,
        locationCode: 1007742,
        locationName: 'Noida, Uttar Pradesh, India',
        device: 'mobile',
      })
      .returning();
    targetId = target!.id;
  });

  afterAll(async () => {
    // Everything cascades from the organisation.
    if (orgId) await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  /* ── Domain rule 9: idempotency ─────────────────────────────────────────── */

  describe('gsc_snapshots idempotency', () => {
    const upsert = (row: {
      gscDate: string;
      gscHour: number | null;
      dataState: 'hourly' | 'fresh' | 'final';
      position: string;
      impressions: number;
    }) =>
      db
        .insert(gscSnapshots)
        .values({
          propertyId,
          keywordId,
          gscDate: row.gscDate,
          gscHour: row.gscHour,
          dataState: row.dataState,
          impressions: row.impressions,
          clicks: 0,
          ctr: '0',
          position: row.position,
        })
        .onConflictDoUpdate({
          target: [
            gscSnapshots.keywordId,
            gscSnapshots.gscDate,
            gscSnapshots.gscHour,
            gscSnapshots.dataState,
          ],
          set: {
            impressions: sql`excluded.impressions`,
            clicks: sql`excluded.clicks`,
            ctr: sql`excluded.ctr`,
            position: sql`excluded.position`,
            fetchedAt: sql`now()`,
          },
        });

    it('re-running a DAILY upsert updates in place instead of duplicating', async () => {
      // The regression this guards: `gsc_hour` is NULL on every final/fresh
      // row, and a plain UNIQUE treats NULLs as distinct — so the constraint
      // would never fire and reconcile would insert a second row every run.
      const date = '2026-09-08';
      await upsert({ gscDate: date, gscHour: null, dataState: 'final', position: '13.40', impressions: 120 });
      await upsert({ gscDate: date, gscHour: null, dataState: 'final', position: '7.80', impressions: 145 });

      const rows = await db
        .select()
        .from(gscSnapshots)
        .where(
          and(
            eq(gscSnapshots.keywordId, keywordId),
            eq(gscSnapshots.gscDate, date),
            isNull(gscSnapshots.gscHour),
            eq(gscSnapshots.dataState, 'final'),
          ),
        );

      expect(rows).toHaveLength(1);
      expect(Number(rows[0]!.position)).toBe(7.8);
      expect(rows[0]!.impressions).toBe(145);
    });

    it('re-running an HOURLY upsert updates in place', async () => {
      const date = '2026-09-09';
      await upsert({ gscDate: date, gscHour: 14, dataState: 'hourly', position: '20.00', impressions: 5 });
      await upsert({ gscDate: date, gscHour: 14, dataState: 'hourly', position: '18.50', impressions: 9 });

      const rows = await db
        .select()
        .from(gscSnapshots)
        .where(
          and(
            eq(gscSnapshots.keywordId, keywordId),
            eq(gscSnapshots.gscDate, date),
            eq(gscSnapshots.gscHour, 14),
          ),
        );

      expect(rows).toHaveLength(1);
      expect(Number(rows[0]!.position)).toBe(18.5);
    });

    it('keeps provisional and final rows for the same date side by side', async () => {
      // Domain rule 3 / acceptance criterion 10: reconciliation must never
      // delete the provisional value — the revision itself is the signal.
      const date = '2026-09-10';
      await upsert({ gscDate: date, gscHour: 9, dataState: 'hourly', position: '35.00', impressions: 4 });
      await upsert({ gscDate: date, gscHour: null, dataState: 'final', position: '13.40', impressions: 88 });

      const rows = await db
        .select({ state: gscSnapshots.dataState, position: gscSnapshots.position })
        .from(gscSnapshots)
        .where(and(eq(gscSnapshots.keywordId, keywordId), eq(gscSnapshots.gscDate, date)));

      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.state).sort()).toEqual(['final', 'hourly']);
    });
  });

  /* ── Domain rule 5: "not found" is not position 100 ─────────────────────── */

  describe('serp_checks', () => {
    it('stores a miss as found=false with NULL ranks, never a sentinel', async () => {
      const checkedAt = new Date('2026-09-11T06:00:00Z');
      await db.insert(serpChecks).values({
        keywordTargetId: targetId,
        propertyId,
        keywordId,
        checkedAt,
        found: false,
        rankGroup: null,
        rankAbsolute: null,
        rankingUrl: null,
        organicResultCount: 100,
        searchDepth: 100,
      });

      const [row] = await db
        .select()
        .from(serpChecks)
        .where(and(eq(serpChecks.keywordTargetId, targetId), eq(serpChecks.checkedAt, checkedAt)));

      expect(row!.found).toBe(false);
      expect(row!.rankGroup).toBeNull();
      expect(row!.rankAbsolute).toBeNull();
    });

    it('rejects a duplicate check for the same target at the same instant', async () => {
      const checkedAt = new Date('2026-09-11T12:00:00Z');
      const values = {
        keywordTargetId: targetId,
        propertyId,
        keywordId,
        checkedAt,
        found: true,
        rankGroup: 7,
        rankAbsolute: 13,
        rankingUrl: 'https://example.com/',
      };

      await db.insert(serpChecks).values(values);
      await expect(db.insert(serpChecks).values(values)).rejects.toThrow();
    });

    it('preserves the rank_group / rank_absolute divergence', async () => {
      // Domain rule 2: these are two different measurements and the gap
      // between them is the SERP furniture penalty.
      const checkedAt = new Date('2026-09-11T18:00:00Z');
      await db.insert(serpChecks).values({
        keywordTargetId: targetId,
        propertyId,
        keywordId,
        checkedAt,
        found: true,
        rankGroup: 7,
        rankAbsolute: 13,
        rankingUrl: 'https://example.com/floor-plan',
        serpFeatures: { ai_overview: false, local_pack: true, images: true, paid_count: 2 },
        competingDomains: [{ rank_group: 1, domain: 'rival.com', url: 'https://rival.com/', title: 'Rival' }],
      });

      const [row] = await db
        .select()
        .from(serpChecks)
        .where(and(eq(serpChecks.keywordTargetId, targetId), eq(serpChecks.checkedAt, checkedAt)));

      expect(row!.rankAbsolute! - row!.rankGroup!).toBe(6);
      expect(row!.serpFeatures).toMatchObject({ local_pack: true });
      expect(Array.isArray(row!.competingDomains)).toBe(true);
    });
  });

  /* ── §9: alert deduplication ────────────────────────────────────────────── */

  describe('alerts open-signature index', () => {
    const signature = `sig-${randomUUID()}`;

    const raise = () =>
      db
        .insert(alerts)
        .values({
          propertyId,
          keywordId,
          keywordTargetId: targetId,
          type: 'lost_top_10',
          severity: 'critical',
          title: 'Dropped out of the top 10',
          body: 'Was 8, now 14.',
          signature,
        })
        .onConflictDoNothing();

    it('re-firing the same open condition is a no-op', async () => {
      await raise();
      await raise();
      await raise();

      const rows = await db.select().from(alerts).where(eq(alerts.signature, signature));
      expect(rows).toHaveLength(1);
    });

    it('resolving frees the signature so a genuine recurrence can alert again', async () => {
      await db
        .update(alerts)
        .set({ resolvedAt: new Date() })
        .where(and(eq(alerts.signature, signature), isNull(alerts.resolvedAt)));

      await raise();

      const rows = await db.select().from(alerts).where(eq(alerts.signature, signature));
      expect(rows).toHaveLength(2);
      expect(rows.filter((r) => r.resolvedAt === null)).toHaveLength(1);
    });
  });

  /* ── Tenancy: deleting an org must not orphan anything ──────────────────── */

  it('cascades deletes from organization down to serp_checks', async () => {
    const slug = `cascade-${randomUUID().slice(0, 8)}`;
    const [org] = await db.insert(organizations).values({ name: 'Cascade', slug }).returning();
    const [property] = await db
      .insert(properties)
      .values({
        orgId: org!.id,
        name: 'P',
        domain: 'c.example',
        gscSiteUrl: `https://${slug}.example/`,
        gscPropertyType: 'url_prefix',
      })
      .returning();
    const [keyword] = await db
      .insert(keywords)
      .values({ propertyId: property!.id, term: 'k' })
      .returning();
    const [target] = await db
      .insert(keywordTargets)
      .values({
        keywordId: keyword!.id,
        propertyId: property!.id,
        locationCode: 2356,
        locationName: 'India',
        device: 'desktop',
      })
      .returning();
    await db.insert(serpChecks).values({
      keywordTargetId: target!.id,
      propertyId: property!.id,
      keywordId: keyword!.id,
      checkedAt: new Date(),
      found: true,
      rankGroup: 3,
      rankAbsolute: 5,
    });

    await db.delete(organizations).where(eq(organizations.id, org!.id));

    const orphans = await db
      .select()
      .from(serpChecks)
      .where(eq(serpChecks.keywordTargetId, target!.id));
    expect(orphans).toHaveLength(0);
  });
});
