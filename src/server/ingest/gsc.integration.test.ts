import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createLogger } from '@/lib/logger';
import { db } from '@/server/db';
import {
  gscBackfillCursors,
  gscSnapshots,
  ingestRuns,
  keywords,
  organizations,
  properties,
} from '@/server/db/schema';
import type { GscClient, SearchAnalyticsQuery, SearchAnalyticsResponse } from './gsc-client';
import { getGscRevisions, getGscSeries } from './gsc-read';
import { backfillFloor, backfillGsc, ingestGscHourly, reconcileGscFinal } from './gsc';

const hasDb = Boolean(process.env.TEST_DATABASE_URL);

/** A logger that swallows output so the suite is readable. */
const quiet = createLogger({}, { minLevel: 'error', sink: () => {} });

/**
 * A fake Search Console that records what was asked and answers from a script.
 * No network, no credentials.
 */
function fakeClient(
  answer: (query: SearchAnalyticsQuery) => SearchAnalyticsResponse | Error,
): GscClient & { calls: SearchAnalyticsQuery[] } {
  const calls: SearchAnalyticsQuery[] = [];
  return {
    calls,
    async listSites() {
      return [];
    },
    async searchAnalytics(_siteUrl, query) {
      calls.push(query);
      const result = answer(query);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

const row = (keys: string[], fields: Partial<{ clicks: number; impressions: number; ctr: number; position: number }>) => ({
  keys,
  clicks: fields.clicks ?? 0,
  impressions: fields.impressions ?? 0,
  ctr: fields.ctr ?? 0,
  ...(fields.position === undefined ? {} : { position: fields.position }),
});

describe.skipIf(!hasDb)('Search Console ingestion', () => {
  let orgId: string;
  let propertyId: string;
  let keywordId: string;
  const now = () => new Date('2026-09-12T20:00:00Z'); // 13:00 PDT on the 12th

  beforeAll(async () => {
    const slug = `gsc-${randomUUID().slice(0, 8)}`;
    const [org] = await db.insert(organizations).values({ name: 'GSC Test', slug }).returning();
    orgId = org!.id;

    const [property] = await db
      .insert(properties)
      .values({
        orgId,
        name: 'Test',
        domain: 'example.com',
        gscSiteUrl: `https://${slug}.example.com/`,
        gscPropertyType: 'url_prefix',
      })
      .returning();
    propertyId = property!.id;

    const [keyword] = await db
      .insert(keywords)
      .values({ propertyId, term: 'prestige sector 150 noida', isPrimary: true })
      .returning();
    keywordId = keyword!.id;
  });

  afterAll(async () => {
    if (orgId) await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  beforeEach(async () => {
    await db.delete(gscSnapshots).where(eq(gscSnapshots.propertyId, propertyId));
    await db.delete(gscBackfillCursors).where(eq(gscBackfillCursors.propertyId, propertyId));
    await db.delete(ingestRuns).where(eq(ingestRuns.propertyId, propertyId));
    await db
      .update(properties)
      .set({ gscDimensionMode: 'unknown', gscDimensionProbedAt: null, backfilledAt: null })
      .where(eq(properties.id, propertyId));
  });

  const countRows = async () => {
    const [result] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(gscSnapshots)
      .where(eq(gscSnapshots.propertyId, propertyId));
    return result?.n ?? 0;
  };

  /* ── Acceptance criterion 2 ───────────────────────────────────────────── */

  describe('idempotency', () => {
    const hourlyAnswer = (query: SearchAnalyticsQuery): SearchAnalyticsResponse =>
      query.dataState === 'hourly_all'
        ? {
            rows: [
              row(['2026-09-11', '2026-09-11T09:00:00-07:00', 'k'], { impressions: 4, position: 18.25 }),
              row(['2026-09-12', '2026-09-12T08:00:00-07:00', 'k'], { clicks: 2, impressions: 31, position: 7.8 }),
            ],
          }
        : { rows: [row(['2026-09-12', 'k'], { clicks: 2, impressions: 35, position: 8.1 })] };

    it('running ingest-gsc twice produces IDENTICAL row counts', async () => {
      const client = fakeClient(hourlyAnswer);

      await ingestGscHourly(propertyId, { client, now });
      const first = await countRows();

      await ingestGscHourly(propertyId, { client, now });
      const second = await countRows();

      expect(first).toBeGreaterThan(0);
      expect(second).toBe(first);
    });

    it('updates metrics in place on the second run rather than inserting', async () => {
      let impressions = 31;
      const client = fakeClient((q) =>
        q.dataState === 'hourly_all'
          ? { rows: [row(['2026-09-12', '2026-09-12T08:00:00-07:00', 'k'], { impressions, position: 7.8 })] }
          : { rows: [] },
      );

      await ingestGscHourly(propertyId, { client, now });
      impressions = 44;
      await ingestGscHourly(propertyId, { client, now });

      const stored = await db
        .select()
        .from(gscSnapshots)
        .where(and(eq(gscSnapshots.keywordId, keywordId), eq(gscSnapshots.dataState, 'hourly')));

      expect(stored).toHaveLength(1);
      expect(stored[0]!.impressions).toBe(44);
    });

    it('reconciliation run twice writes one final row', async () => {
      const client = fakeClient(() => ({
        rows: [row(['2026-09-08', 'k'], { clicks: 3, impressions: 88, position: 13.4 })],
      }));

      await reconcileGscFinal(propertyId, { client, now });
      await reconcileGscFinal(propertyId, { client, now });

      const finals = await db
        .select()
        .from(gscSnapshots)
        .where(and(eq(gscSnapshots.keywordId, keywordId), eq(gscSnapshots.dataState, 'final')));

      expect(finals).toHaveLength(1);
    });
  });

  /* ── Acceptance criterion 10 ──────────────────────────────────────────── */

  describe('reconciliation', () => {
    it('replaces the provisional figure while keeping it queryable', async () => {
      // Hourly said 35.0 on 4 impressions. The finalised figure is 13.4 on 88.
      const hourly = fakeClient((q) =>
        q.dataState === 'hourly_all'
          ? { rows: [row(['2026-09-08', '2026-09-08T09:00:00-07:00', 'k'], { impressions: 4, position: 35 })] }
          : { rows: [] },
      );
      await ingestGscHourly(propertyId, { client: hourly, now: () => new Date('2026-09-09T20:00:00Z') });

      const final = fakeClient(() => ({
        rows: [row(['2026-09-08', 'k'], { clicks: 3, impressions: 88, position: 13.4 })],
      }));
      await reconcileGscFinal(propertyId, { client: final, now });

      const series = await getGscSeries(keywordId, '2026-09-08', '2026-09-08');

      expect(series[0]!.source).toBe('final');
      expect(series[0]!.position).toBe(13.4);
      expect(series[0]!.provisional).toEqual([
        expect.objectContaining({ source: 'hourly', position: 35 }),
      ]);

      // And the raw provisional row is still on disk.
      const revisions = await getGscRevisions(keywordId, '2026-09-08');
      expect(revisions.map((r) => r.dataState).sort()).toEqual(['final', 'hourly']);
    });

    it('never deletes provisional rows', async () => {
      const hourly = fakeClient((q) =>
        q.dataState === 'hourly_all'
          ? { rows: [row(['2026-09-08', '2026-09-08T09:00:00-07:00', 'k'], { impressions: 4, position: 35 })] }
          : { rows: [] },
      );
      await ingestGscHourly(propertyId, { client: hourly, now: () => new Date('2026-09-09T20:00:00Z') });
      const before = await countRows();

      const final = fakeClient(() => ({ rows: [row(['2026-09-08', 'k'], { impressions: 88, position: 13.4 })] }));
      await reconcileGscFinal(propertyId, { client: final, now });

      expect(await countRows()).toBeGreaterThan(before);
    });
  });

  /* ── Acceptance criterion 3 ───────────────────────────────────────────── */

  it('stores position NULL for a zero-impression date and returns a gap', async () => {
    const client = fakeClient((q) =>
      q.dataState === 'hourly_all'
        ? { rows: [row(['2026-09-12', '2026-09-12T08:00:00-07:00', 'k'], { impressions: 0 })] }
        : { rows: [] },
    );

    await ingestGscHourly(propertyId, { client, now });

    const [stored] = await db
      .select()
      .from(gscSnapshots)
      .where(and(eq(gscSnapshots.keywordId, keywordId), eq(gscSnapshots.dataState, 'hourly')));

    expect(stored!.impressions).toBe(0);
    expect(stored!.position).toBeNull();

    const series = await getGscSeries(keywordId, '2026-09-12', '2026-09-12');
    expect(series[0]!.position).toBeNull();
    expect(series[0]!.position).not.toBe(0);
  });

  /* ── The dimension fallback ───────────────────────────────────────────── */

  describe('date+hour dimension fallback', () => {
    const combinedRejected = (query: SearchAnalyticsQuery) => {
      if (query.dimensions.includes('date') && query.dimensions.includes('hour')) {
        return Object.assign(new Error('Invalid dimension combination'), { status: 400 });
      }
      if (query.dataState === 'hourly_all') {
        return { rows: [row(['13', 'k'], { impressions: 12, position: 9.5 })] };
      }
      return { rows: [] };
    };

    it('falls back to one request per date on a 400, and still ingests', async () => {
      const client = fakeClient(combinedRejected);
      await ingestGscHourly(propertyId, { client, now });

      const stored = await db
        .select()
        .from(gscSnapshots)
        .where(and(eq(gscSnapshots.keywordId, keywordId), eq(gscSnapshots.dataState, 'hourly')));

      // One row per date, each recovered from the per-date request.
      expect(stored).toHaveLength(2);
      expect(stored.every((r) => r.gscHour === 13)).toBe(true);
    });

    it('caches the answer so the failing shape is NOT retried next hour', async () => {
      const client = fakeClient(combinedRejected);
      await ingestGscHourly(propertyId, { client, now });

      const [after] = await db.select().from(properties).where(eq(properties.id, propertyId));
      expect(after!.gscDimensionMode).toBe('per_date');
      expect(after!.gscDimensionProbedAt).toBeInstanceOf(Date);

      const second = fakeClient(combinedRejected);
      await ingestGscHourly(propertyId, { client: second, now });

      const combinedAttempts = second.calls.filter(
        (c) => c.dimensions.includes('date') && c.dimensions.includes('hour'),
      );
      expect(combinedAttempts).toHaveLength(0);
    });

    it('records "combined" when the combined shape works', async () => {
      const client = fakeClient((q) =>
        q.dataState === 'hourly_all'
          ? { rows: [row(['2026-09-12', '2026-09-12T08:00:00-07:00', 'k'], { impressions: 31, position: 7.8 })] }
          : { rows: [] },
      );

      await ingestGscHourly(propertyId, { client, now });

      const [after] = await db.select().from(properties).where(eq(properties.id, propertyId));
      expect(after!.gscDimensionMode).toBe('combined');
    });

    it('does NOT treat a 500 as a reason to downgrade the shape', async () => {
      // Only a 400 means "wrong shape". A 5xx is transient and must not
      // permanently downgrade the property to the slower path.
      const client = fakeClient(() => Object.assign(new Error('upstream'), { status: 500 }));

      await expect(ingestGscHourly(propertyId, { client, now })).resolves.toMatchObject({
        keywordsFailed: 1,
      });

      const [after] = await db.select().from(properties).where(eq(properties.id, propertyId));
      expect(after!.gscDimensionMode).toBe('unknown');
    });
  });

  /* ── Pacific dates ────────────────────────────────────────────────────── */

  it('requests PACIFIC dates, not local ones', async () => {
    // 04:30 UTC on the 12th is 21:30 PDT on the 11th. The window must be
    // 10th-11th, not 11th-12th.
    const client = fakeClient(() => ({ rows: [] }));
    await ingestGscHourly(propertyId, { client, now: () => new Date('2026-09-12T04:30:00Z') });

    const hourlyCall = client.calls.find((c) => c.dataState === 'hourly_all');
    expect(hourlyCall).toMatchObject({ startDate: '2026-09-10', endDate: '2026-09-11' });
  });

  it('pulls the fresh daily window back to T-3, covering the gap before reconciliation', async () => {
    // Reconciliation settles exactly T-4. Without a wider fresh window, T-3 and
    // T-2 would show our aggregate of partial hourly buckets instead of a daily
    // figure Google computed.
    const client = fakeClient(() => ({ rows: [] }));
    await ingestGscHourly(propertyId, { client, now });

    const freshCall = client.calls.find((c) => c.dataState === 'all');
    expect(freshCall).toMatchObject({ startDate: '2026-09-09', endDate: '2026-09-12' });
  });

  it('writes fresh rows that outrank hourly but yield to final', async () => {
    const client = fakeClient((q) =>
      q.dataState === 'hourly_all'
        ? { rows: [row(['2026-09-11', '2026-09-11T09:00:00-07:00', 'k'], { impressions: 4, position: 30 })] }
        : { rows: [row(['2026-09-11', 'k'], { clicks: 1, impressions: 52, position: 18.5 })] },
    );

    await ingestGscHourly(propertyId, { client, now });

    const series = await getGscSeries(keywordId, '2026-09-11', '2026-09-11');
    expect(series[0]!.source).toBe('fresh');
    expect(series[0]!.position).toBe(18.5);
    expect(series[0]!.provisional).toEqual([
      expect.objectContaining({ source: 'hourly', position: 30 }),
    ]);
  });

  it('reconciles exactly T-4 in Pacific Time', async () => {
    const client = fakeClient(() => ({ rows: [] }));
    await reconcileGscFinal(propertyId, { client, now });

    expect(client.calls[0]).toMatchObject({
      startDate: '2026-09-08',
      endDate: '2026-09-08',
      dataState: 'final',
    });
  });

  /* ── ingest_runs ──────────────────────────────────────────────────────── */

  describe('run recording', () => {
    it('records a success run with rows written', async () => {
      const client = fakeClient((q) =>
        q.dataState === 'hourly_all'
          ? { rows: [row(['2026-09-12', '2026-09-12T08:00:00-07:00', 'k'], { impressions: 31, position: 7.8 })] }
          : { rows: [] },
      );

      await ingestGscHourly(propertyId, { client, now });

      const [run] = await db
        .select()
        .from(ingestRuns)
        .where(and(eq(ingestRuns.propertyId, propertyId), eq(ingestRuns.kind, 'gsc_hourly')));

      expect(run!.status).toBe('success');
      expect(run!.rowsWritten).toBeGreaterThan(0);
      expect(run!.finishedAt).toBeInstanceOf(Date);
    });

    it('records PARTIAL when some keywords fail but others succeed', async () => {
      const [second] = await db
        .insert(keywords)
        .values({ propertyId, term: 'doomed keyword' })
        .returning();

      const client = fakeClient((q) => {
        const term = q.dimensionFilterGroups?.[0]?.filters[0]?.expression;
        if (term === 'doomed keyword') return Object.assign(new Error('nope'), { status: 403 });
        return q.dataState === 'hourly_all'
          ? { rows: [row(['2026-09-12', '2026-09-12T08:00:00-07:00', 'k'], { impressions: 5, position: 9 })] }
          : { rows: [] };
      });

      const result = await ingestGscHourly(propertyId, { client, now });

      expect(result.keywordsProcessed).toBe(1);
      expect(result.keywordsFailed).toBe(1);

      const [run] = await db
        .select()
        .from(ingestRuns)
        .where(and(eq(ingestRuns.propertyId, propertyId), eq(ingestRuns.kind, 'gsc_hourly')));
      expect(run!.status).toBe('partial');

      await db.delete(keywords).where(eq(keywords.id, second!.id));
    });
  });

  /* ── Failure handling (found by adversarial review) ───────────────────── */

  describe('failure handling', () => {
    it('records FAILED, not partial, when every keyword fails', async () => {
      // An all-failed run is an outage. Recording it as `partial` would show a
      // warning on /ops where it should show a failure.
      const client = fakeClient(() => Object.assign(new Error('denied'), { status: 403 }));

      const result = await ingestGscHourly(propertyId, { client, now });
      expect(result.keywordsProcessed).toBe(0);

      const [run] = await db
        .select()
        .from(ingestRuns)
        .where(and(eq(ingestRuns.propertyId, propertyId), eq(ingestRuns.kind, 'gsc_hourly')));

      expect(run!.status).toBe('failed');
    });

    it('reports PARTIAL when the per-date fallback loses some dates', async () => {
      // Returning the surviving dates as if the window were complete would
      // store a partial day and call the run a success.
      const client = fakeClient((q) => {
        if (q.dimensions.includes('date') && q.dimensions.includes('hour')) {
          return Object.assign(new Error('bad combo'), { status: 400 });
        }
        if (q.dataState === 'hourly_all') {
          // The earlier of the two dates fails; the later succeeds.
          if (q.startDate === '2026-09-11') {
            return Object.assign(new Error('upstream'), { status: 503 });
          }
          return { rows: [row(['13', 'k'], { impressions: 12, position: 9.5 })] };
        }
        return { rows: [] };
      });

      await ingestGscHourly(propertyId, { client, now });

      const [run] = await db
        .select()
        .from(ingestRuns)
        .where(and(eq(ingestRuns.propertyId, propertyId), eq(ingestRuns.kind, 'gsc_hourly')));

      expect(run!.status).toBe('partial');
      expect(run!.error).toContain('2026-09-11');
    });

    it('counts rows already committed when a later request for the same keyword fails', async () => {
      // The hourly rows are on disk before the `fresh` request runs. Reporting
      // rows_written as 0 for that keyword would understate the run.
      const client = fakeClient((q) =>
        q.dataState === 'hourly_all'
          ? { rows: [row(['2026-09-12', '2026-09-12T08:00:00-07:00', 'k'], { impressions: 31, position: 7.8 })] }
          : Object.assign(new Error('fresh failed'), { status: 500 }),
      );

      await ingestGscHourly(propertyId, { client, now });

      const [run] = await db
        .select()
        .from(ingestRuns)
        .where(and(eq(ingestRuns.propertyId, propertyId), eq(ingestRuns.kind, 'gsc_hourly')));

      expect(run!.rowsWritten).toBeGreaterThan(0);
    });

    it('counts every keyword\'s rows — the tally must not lose concurrent updates', async () => {
      // `tally.rows += await f()` reads the tally BEFORE suspending, so two
      // concurrent keywords both read the old value and one update is lost.
      // With 6-way concurrency and one keyword the bug is invisible.
      const extras = await db
        .insert(keywords)
        .values([
          { propertyId, term: 'second keyword' },
          { propertyId, term: 'third keyword' },
          { propertyId, term: 'fourth keyword' },
        ])
        .returning();

      const client = fakeClient((q) =>
        q.dataState === 'hourly_all'
          ? { rows: [row(['2026-09-12', '2026-09-12T08:00:00-07:00', 'k'], { impressions: 5, position: 9 })] }
          : { rows: [row(['2026-09-12', 'k'], { impressions: 7, position: 8 })] },
      );

      await ingestGscHourly(propertyId, { client, now });

      const actual = await countRows();
      const [run] = await db
        .select()
        .from(ingestRuns)
        .where(and(eq(ingestRuns.propertyId, propertyId), eq(ingestRuns.kind, 'gsc_hourly')));

      expect(actual).toBe(8); // 4 keywords x (1 hourly + 1 fresh)
      expect(run!.rowsWritten).toBe(actual);

      for (const extra of extras) await db.delete(keywords).where(eq(keywords.id, extra.id));
    });

    it('does not let ONE keyword 400 downgrade a property whose other keywords work', async () => {
      // A 400 can have causes other than the dimension combination. Downgrading
      // on the first one to arrive makes the answer a race.
      const [second] = await db
        .insert(keywords)
        .values({ propertyId, term: 'odd keyword' })
        .returning();

      const client = fakeClient((q) => {
        const term = q.dimensionFilterGroups?.[0]?.filters[0]?.expression;
        const combined = q.dimensions.includes('date') && q.dimensions.includes('hour');
        if (combined && term === 'odd keyword') {
          return Object.assign(new Error('bad filter'), { status: 400 });
        }
        if (q.dataState === 'hourly_all') {
          return { rows: [row(['2026-09-12', '2026-09-12T08:00:00-07:00', 'k'], { impressions: 5, position: 9 })] };
        }
        return { rows: [] };
      });

      await ingestGscHourly(propertyId, { client, now });

      const [after] = await db.select().from(properties).where(eq(properties.id, propertyId));
      expect(after!.gscDimensionMode).toBe('combined');

      await db.delete(keywords).where(eq(keywords.id, second!.id));
    });
  });

  /* ── Backfill ─────────────────────────────────────────────────────────── */

  describe('backfill', () => {
    it('computes a 16-month floor', () => {
      expect(backfillFloor('2026-09-12')).toBe('2025-05-12');
    });

    it('walks backwards in 3-month windows and completes', async () => {
      const client = fakeClient((q) => ({
        rows: [row([q.startDate, 'k'], { impressions: 10, position: 12 })],
      }));

      const result = await backfillGsc(propertyId, { client, now });

      expect(result.complete).toBe(true);
      expect(result.windowsProcessed).toBeGreaterThanOrEqual(6);

      const [property] = await db.select().from(properties).where(eq(properties.id, propertyId));
      expect(property!.backfilledAt).toBeInstanceOf(Date);
    });

    it('never requests a date older than the retention floor', async () => {
      const client = fakeClient((q) => ({ rows: [] }));
      await backfillGsc(propertyId, { client, now });

      const floor = backfillFloor('2026-09-12');
      expect(client.calls.every((c) => c.startDate >= floor)).toBe(true);
    });

    it('RESUMES where it stopped rather than restarting', async () => {
      const client = fakeClient((q) => ({
        rows: [row([q.startDate, 'k'], { impressions: 10, position: 12 })],
      }));

      // A tiny budget forces the first invocation to stop part-way.
      const first = await backfillGsc(propertyId, { client, now, budgetMs: 0 });
      expect(first.complete).toBe(false);

      const [cursorAfterFirst] = await db
        .select()
        .from(gscBackfillCursors)
        .where(eq(gscBackfillCursors.keywordId, keywordId));

      const second = await backfillGsc(propertyId, { client, now });
      expect(second.complete).toBe(true);

      // The second invocation continued from the cursor, not from today.
      const restarted = client.calls.some(
        (c) => cursorAfterFirst?.coveredFrom && c.endDate > cursorAfterFirst.coveredFrom,
      );
      expect(restarted).toBe(false);
    });

    it('is idempotent — re-running a completed backfill adds no rows', async () => {
      const client = fakeClient((q) => ({
        rows: [row([q.startDate, 'k'], { impressions: 10, position: 12 })],
      }));

      await backfillGsc(propertyId, { client, now });
      const after = await countRows();
      const [property] = await db.select().from(properties).where(eq(properties.id, propertyId));
      const stamped = property!.backfilledAt;

      await backfillGsc(propertyId, { client, now });

      expect(await countRows()).toBe(after);

      // backfilled_at must not move on a re-run.
      const [again] = await db.select().from(properties).where(eq(properties.id, propertyId));
      expect(again!.backfilledAt?.getTime()).toBe(stamped?.getTime());
    });

    it('does not wedge when a keyword is deactivated mid-backfill', async () => {
      // The cursor stays open — deactivation is reversible, so marking it
      // complete would be a lie — but counting it would leave the property
      // permanently incomplete and every future run would do nothing.
      const [extra] = await db
        .insert(keywords)
        .values({ propertyId, term: 'to be retired' })
        .returning();

      const client = fakeClient((q) => ({
        rows: [row([q.startDate, 'k'], { impressions: 10, position: 12 })],
      }));

      await backfillGsc(propertyId, { client, now, budgetMs: 0 });
      await db.update(keywords).set({ isActive: false }).where(eq(keywords.id, extra!.id));

      const result = await backfillGsc(propertyId, { client, now });

      expect(result.complete).toBe(true);
      expect(result.keywordsRemaining).toBe(0);

      // The retired keyword's cursor is still open, not falsely completed.
      const [cursor] = await db
        .select()
        .from(gscBackfillCursors)
        .where(eq(gscBackfillCursors.keywordId, extra!.id));
      expect(cursor?.completedAt).toBeNull();

      await db.delete(keywords).where(eq(keywords.id, extra!.id));
    });

    it('sidelines a failing keyword instead of retrying it at full speed', async () => {
      // A failing window does not advance its cursor, by design. Without
      // sidelining, the outer loop picks the same keyword up immediately and
      // hammers Google until the budget runs out.
      let calls = 0;
      const client = fakeClient(() => {
        calls++;
        return Object.assign(new Error('upstream'), { status: 500 });
      });

      const result = await backfillGsc(propertyId, { client, now });

      expect(result.complete).toBe(false);
      // One attempt for the one keyword, not a loop until the 45s budget.
      expect(calls).toBe(1);
    });

    it('shares one deadline across properties rather than 45s each', async () => {
      // Ten properties at 45s each asks for 450 seconds inside a 60-second
      // function — the exact mid-window kill the budget exists to prevent.
      const client = fakeClient((q) => ({
        rows: [row([q.startDate, 'k'], { impressions: 10, position: 12 })],
      }));

      const deadline = Date.now() - 1; // already expired
      const result = await backfillGsc(propertyId, { client, now, deadline });

      expect(result.windowsProcessed).toBe(0);
      expect(result.complete).toBe(false);
    });

    it('records FAILED when every backfill window failed', async () => {
      const client = fakeClient(() => Object.assign(new Error('upstream'), { status: 500 }));
      await backfillGsc(propertyId, { client, now });

      const [run] = await db
        .select()
        .from(ingestRuns)
        .where(and(eq(ingestRuns.propertyId, propertyId), eq(ingestRuns.kind, 'gsc_backfill')));

      expect(run!.status).toBe('failed');
    });

    it('does not stamp backfilled_at for a property with no active keywords', async () => {
      const [org] = await db
        .insert(organizations)
        .values({ name: 'Empty', slug: `empty-${randomUUID().slice(0, 8)}` })
        .returning();
      const [empty] = await db
        .insert(properties)
        .values({
          orgId: org!.id,
          name: 'Empty',
          domain: 'empty.example',
          gscSiteUrl: `https://empty-${randomUUID().slice(0, 8)}.example/`,
          gscPropertyType: 'url_prefix',
        })
        .returning();

      const result = await backfillGsc(empty!.id, { client: fakeClient(() => ({ rows: [] })), now });

      expect(result.complete).toBe(false);

      const [after] = await db.select().from(properties).where(eq(properties.id, empty!.id));
      expect(after!.backfilledAt).toBeNull();

      await db.delete(organizations).where(eq(organizations.id, org!.id));
    });

    it('backfills a keyword added AFTER the property was marked complete', async () => {
      // The failure mode a property-level "done" flag would have: the new
      // keyword would be left permanently blank.
      const client = fakeClient((q) => ({
        rows: [row([q.startDate, 'k'], { impressions: 10, position: 12 })],
      }));
      await backfillGsc(propertyId, { client, now });

      const [late] = await db.insert(keywords).values({ propertyId, term: 'added later' }).returning();

      const result = await backfillGsc(propertyId, { client, now });
      expect(result.windowsProcessed).toBeGreaterThan(0);

      const [cursor] = await db
        .select()
        .from(gscBackfillCursors)
        .where(eq(gscBackfillCursors.keywordId, late!.id));

      expect(cursor?.completedAt).toBeInstanceOf(Date);

      await db.delete(keywords).where(eq(keywords.id, late!.id));
    });
  });

  /* ── Read precedence, end to end ──────────────────────────────────────── */

  it('resolves final over fresh over hourly through the real database', async () => {
    await db.insert(gscSnapshots).values([
      { propertyId, keywordId, gscDate: '2026-09-08', gscHour: 9, dataState: 'hourly', clicks: 0, impressions: 4, ctr: '0', position: '35.00' },
      { propertyId, keywordId, gscDate: '2026-09-08', gscHour: null, dataState: 'fresh', clicks: 1, impressions: 40, ctr: '0.025', position: '21.00' },
      { propertyId, keywordId, gscDate: '2026-09-08', gscHour: null, dataState: 'final', clicks: 3, impressions: 88, ctr: '0.034091', position: '13.40' },
      { propertyId, keywordId, gscDate: '2026-09-09', gscHour: 9, dataState: 'hourly', clicks: 0, impressions: 6, ctr: '0', position: '9.00' },
    ]);

    const series = await getGscSeries(keywordId, '2026-09-07', '2026-09-09');

    expect(series.map((p) => [p.date, p.source, p.position])).toEqual([
      ['2026-09-07', 'none', null],
      ['2026-09-08', 'final', 13.4],
      ['2026-09-09', 'hourly', 9],
    ]);

    // Numerics survived the driver as numbers, not strings.
    expect(typeof series[1]!.position).toBe('number');
    expect(series[1]!.position! + 1).toBe(14.4);
  });
});
