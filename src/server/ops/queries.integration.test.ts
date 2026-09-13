import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/server/db';
import {
  ingestRuns,
  keywordTargets,
  keywords,
  organizations,
  properties,
  serpChecks,
} from '@/server/db/schema';
import { withIngestRun } from '@/server/ingest/runs';
import { GSC_STALE_HOURS, ingestHealth, monthToDateSpend, recentIngestRuns } from './queries';

const hasDb = Boolean(process.env.TEST_DATABASE_URL);

describe.skipIf(!hasDb)('ops queries', () => {
  let orgId: string;
  let propertyId: string;
  let keywordId: string;
  let targetId: string;

  beforeAll(async () => {
    const slug = `ops-${randomUUID().slice(0, 8)}`;
    const [org] = await db.insert(organizations).values({ name: 'Ops', slug }).returning();
    orgId = org!.id;

    const [property] = await db
      .insert(properties)
      .values({
        orgId,
        name: `Ops Property ${slug}`,
        domain: 'example.com',
        gscSiteUrl: `https://${slug}.example.com/`,
        gscPropertyType: 'url_prefix',
      })
      .returning();
    propertyId = property!.id;

    const [keyword] = await db.insert(keywords).values({ propertyId, term: 'ops kw' }).returning();
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
    await db.delete(ingestRuns).where(eq(ingestRuns.propertyId, propertyId));
  });

  describe('monthToDateSpend', () => {
    it('sums serp_checks.cost_usd — the authoritative figure', async () => {
      // Acceptance criterion 9: /ops must agree with this sum to within a cent.
      const now = new Date();
      const thisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 15, 12));

      await db.insert(serpChecks).values([
        {
          keywordTargetId: targetId,
          propertyId,
          keywordId,
          checkedAt: thisMonth,
          found: true,
          rankGroup: 7,
          rankAbsolute: 13,
          costUsd: '0.000600',
        },
        {
          keywordTargetId: targetId,
          propertyId,
          keywordId,
          checkedAt: new Date(thisMonth.getTime() + 3_600_000),
          found: true,
          rankGroup: 8,
          rankAbsolute: 14,
          costUsd: '0.002000',
        },
      ]);

      const spend = await monthToDateSpend(now);
      expect(spend.monthToDateUsd).toBeGreaterThanOrEqual(0.0026);
      expect(spend.checksThisMonth).toBeGreaterThanOrEqual(2);
    });

    it('parses numerics as numbers, not strings', async () => {
      // cost_usd crosses the driver as a string; summing it as one would
      // concatenate rather than add.
      const spend = await monthToDateSpend();
      expect(typeof spend.monthToDateUsd).toBe('number');
      expect(Number.isNaN(spend.monthToDateUsd)).toBe(false);
    });

    it('returns zero rather than NaN when nothing has been spent', async () => {
      const future = new Date(Date.UTC(2099, 0, 15));
      const spend = await monthToDateSpend(future);

      expect(spend.monthToDateUsd).toBe(0);
      expect(spend.projectedMonthUsd).toBe(0);
    });

    it('reports the run estimate separately from the charged total', async () => {
      // A gap between them means tasks were submitted and never came back.
      const spend = await monthToDateSpend();
      expect(spend).toHaveProperty('estimatedFromRunsUsd');
      expect(typeof spend.estimatedFromRunsUsd).toBe('number');
    });
  });

  describe('recentIngestRuns', () => {
    it('returns runs newest first with a computed duration', async () => {
      await db.insert(ingestRuns).values({
        kind: 'serp_batch',
        propertyId,
        status: 'success',
        rowsWritten: 5,
        costUsd: '0.003000',
        startedAt: new Date(Date.now() - 5000),
        finishedAt: new Date(Date.now() - 2000),
      });

      const runs = await recentIngestRuns(50);
      const mine = runs.find((r) => r.propertyName?.includes('Ops Property'));

      expect(mine).toBeDefined();
      expect(mine!.durationMs).toBeGreaterThan(0);
      expect(mine!.costUsd).toBeCloseTo(0.003, 6);
      expect(typeof mine!.costUsd).toBe('number');

      // Raw db.execute hands timestamps back as STRINGS. The /ops page calls
      // .getTime() on these, so a string here is a 500, not a formatting nit.
      expect(mine!.startedAt).toBeInstanceOf(Date);
      expect(mine!.finishedAt).toBeInstanceOf(Date);
      expect(() => mine!.startedAt.getTime()).not.toThrow();
    });

    it('handles a run that never finished', async () => {
      // A function killed mid-flight leaves `running` with no finished_at.
      // That must render, not crash — it is the state worth noticing.
      await db.insert(ingestRuns).values({
        kind: 'gsc_hourly',
        propertyId,
        status: 'running',
        startedAt: new Date(),
      });

      const runs = await recentIngestRuns(50);
      const stuck = runs.find((r) => r.status === 'running' && r.propertyName?.includes('Ops Property'));

      expect(stuck).toBeDefined();
      expect(stuck!.durationMs).toBeNull();
    });

    /*
     * Per KIND, not overall — and that is the whole point of the cap.
     *
     * `serp_batch` opens one run per delivered pingback, roughly one every 54
     * seconds at the documented volume. Under a flat global limit those rows
     * crowded out every other job within about 45 minutes, so a failed hourly
     * `ingest-gsc` scrolled off the page the operator checks for exactly that.
     */
    it('caps each job separately, so a chatty job cannot bury a quiet one', async () => {
      const noisy = 'serp_batch' as const;
      for (let i = 0; i < 6; i++) {
        await withIngestRun({ kind: noisy, propertyId }, async () => undefined);
      }
      await withIngestRun({ kind: 'rollup', propertyId }, async () => undefined);

      const runs = await recentIngestRuns(2);
      const byKind = new Map<string, number>();
      for (const run of runs) byKind.set(run.kind, (byKind.get(run.kind) ?? 0) + 1);

      for (const [kind, count] of byKind) {
        expect(count, `${kind} exceeded the per-kind cap`).toBeLessThanOrEqual(2);
      }

      // The quiet job survives the noisy one, which is the property the flat
      // limit lost.
      expect(byKind.get('rollup') ?? 0).toBeGreaterThan(0);
    });
  });

  describe('ingestHealth', () => {
    it('marks a property that has NEVER produced a row as stale', async () => {
      // The state a misconfigured property sits in, and the one most worth
      // catching — silent ingest death produces no error, only an absence.
      const health = await ingestHealth();
      const mine = health.find((h) => h.propertyId === propertyId);

      expect(mine).toBeDefined();
      expect(mine!.lastGscRowAt).toBeNull();
      expect(mine!.gscStale).toBe(true);
      expect(mine!.hoursSinceGscRow).toBeNull();
    });

    it('reports hours since the last SERP check', async () => {
      await db.insert(serpChecks).values({
        keywordTargetId: targetId,
        propertyId,
        keywordId,
        checkedAt: new Date(Date.now() - 2 * 3_600_000),
        found: true,
        rankGroup: 7,
        rankAbsolute: 13,
      });

      const mine = (await ingestHealth()).find((h) => h.propertyId === propertyId);
      expect(mine!.lastSerpCheckAt).toBeInstanceOf(Date);
      expect(mine!.hoursSinceSerpCheck).toBeCloseTo(2, 0);
    });

    it('uses the 36-hour threshold §12 specifies', () => {
      expect(GSC_STALE_HOURS).toBe(36);
    });
  });
});
