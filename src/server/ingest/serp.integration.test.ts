import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { db } from '@/server/db';
import {
  ingestRuns,
  keywordTargets,
  keywords,
  organizations,
  properties,
  serpChecks,
  serpPayloads,
} from '@/server/db/schema';
import foundFixture from '@/test/fixtures/dataforseo/live-advanced-found.json';
import notFoundFixture from '@/test/fixtures/dataforseo/live-advanced-not-found.json';
import taskGetError from '@/test/fixtures/dataforseo/task-get-error.json';
import taskPostResponse from '@/test/fixtures/dataforseo/task-post-response.json';

import type { DataForSeoClient, SerpTaskRequest } from './dataforseo-client';
import type { SerpEnvelope } from './serp-parse';
import {
  LIVE_CHECK_COOLDOWN_MS,
  claimDueTargets,
  dueTargets,
  enqueueSerpBatch,
  handleSerpPingback,
  liveCheckTarget,
} from './serp';

const hasDb = Boolean(process.env.TEST_DATABASE_URL);

/** Deep clone so a test mutating a fixture cannot leak into the next. */
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

interface Recorder {
  posts: SerpTaskRequest[][];
  gets: string[];
  lives: SerpTaskRequest[];
}

function fakeClient(
  answers: {
    post?: (tasks: readonly SerpTaskRequest[]) => SerpEnvelope | Error;
    get?: (taskId: string) => SerpEnvelope | Error;
    live?: (task: SerpTaskRequest) => SerpEnvelope | Error;
  } = {},
): DataForSeoClient & Recorder {
  const rec: Recorder = { posts: [], gets: [], lives: [] };

  const unwrap = (value: SerpEnvelope | Error): SerpEnvelope => {
    if (value instanceof Error) throw value;
    return value;
  };

  return {
    ...rec,
    async taskPost(tasks) {
      rec.posts.push([...tasks]);
      return unwrap(
        answers.post?.([...tasks]) ?? {
          status_code: 20000,
          tasks: tasks.map((t, i) => ({
            id: `task-${i}`,
            status_code: 20100,
            status_message: 'Task Created.',
            cost: 0.0006,
            data: { tag: t.tag },
            result: null,
          })),
        },
      );
    },
    async taskGetAdvanced(taskId) {
      rec.gets.push(taskId);
      return unwrap(answers.get?.(taskId) ?? (clone(foundFixture) as unknown as SerpEnvelope));
    },
    async liveAdvanced(task) {
      rec.lives.push(task);
      return unwrap(answers.live?.(task) ?? (clone(foundFixture) as unknown as SerpEnvelope));
    },
    async balance() {
      return 50;
    },
    async locations() {
      return [];
    },
  } as DataForSeoClient & Recorder;
}

/** Retag a fixture so its `tag` routes to a real target id. */
function taggedFound(targetId: string, overrides: Record<string, unknown> = {}): SerpEnvelope {
  const envelope = clone(foundFixture) as unknown as SerpEnvelope;
  const task = envelope.tasks![0]!;
  task.data = { ...task.data, tag: targetId };
  Object.assign(task, overrides);
  return envelope;
}

/** Restate a fixture's cost, so a test can use the real `task_get` shape. */
function withTaskCost(envelope: SerpEnvelope, cost: number): SerpEnvelope {
  return {
    ...envelope,
    cost,
    tasks: (envelope.tasks ?? []).map((task) => ({ ...task, cost })),
  };
}

describe.skipIf(!hasDb)('DataForSEO ingestion', () => {
  let orgId: string;
  let propertyId: string;
  let keywordId: string;
  let targetId: string;
  const now = () => new Date('2026-09-12T15:00:00Z');

  beforeAll(async () => {
    const slug = `serp-${randomUUID().slice(0, 8)}`;
    const [org] = await db.insert(organizations).values({ name: 'SERP Test', slug }).returning();
    orgId = org!.id;

    const [property] = await db
      .insert(properties)
      .values({
        orgId,
        name: 'Prestige',
        domain: 'prestigenoidasector150.com',
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

    const [target] = await db
      .insert(keywordTargets)
      .values({
        keywordId,
        propertyId,
        locationCode: 1007742,
        locationName: 'Noida, Uttar Pradesh, India',
        device: 'mobile',
        checkIntervalMin: 360,
      })
      .returning();
    targetId = target!.id;
  });

  afterAll(async () => {
    if (orgId) await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  beforeEach(async () => {
    await db.delete(serpChecks).where(eq(serpChecks.propertyId, propertyId));
    await db.delete(ingestRuns).where(eq(ingestRuns.kind, 'serp_batch'));
    await db
      .update(keywordTargets)
      .set({ lastCheckedAt: null, lastEnqueuedAt: null, lastLiveCheckAt: null })
      .where(eq(keywordTargets.propertyId, propertyId));
  });

  /** A desktop variant of our target, for the os-derivation test. */
  const desktopTarget = async () => {
    const [row] = await db.select().from(keywordTargets).where(eq(keywordTargets.id, targetId));
    return { ...row!, device: 'desktop' as const };
  };

  const countChecks = async () => {
    const [r] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(serpChecks)
      .where(eq(serpChecks.propertyId, propertyId));
    return r?.n ?? 0;
  };

  /* ── Selection ────────────────────────────────────────────────────────── */

  describe('dueTargets', () => {
    it('includes a target never checked', async () => {
      const due = await dueTargets();
      expect(due.map((d) => d.target.id)).toContain(targetId);
    });

    it('excludes a target checked inside its interval', async () => {
      await db
        .update(keywordTargets)
        .set({ lastCheckedAt: new Date() })
        .where(eq(keywordTargets.id, targetId));

      const due = await dueTargets();
      expect(due.map((d) => d.target.id)).not.toContain(targetId);
    });

    it('includes a target once its interval has elapsed', async () => {
      await db
        .update(keywordTargets)
        .set({ lastCheckedAt: new Date(Date.now() - 7 * 3600 * 1000) })
        .where(eq(keywordTargets.id, targetId));

      expect((await dueTargets()).map((d) => d.target.id)).toContain(targetId);
    });

    it('respects a SHORTER interval for a money keyword', async () => {
      // §13's cost levers depend on per-target intervals actually working.
      await db
        .update(keywordTargets)
        .set({ checkIntervalMin: 60, lastCheckedAt: new Date(Date.now() - 90 * 60 * 1000) })
        .where(eq(keywordTargets.id, targetId));

      expect((await dueTargets()).map((d) => d.target.id)).toContain(targetId);

      await db
        .update(keywordTargets)
        .set({ checkIntervalMin: 360 })
        .where(eq(keywordTargets.id, targetId));
    });

    it('excludes an inactive target, keyword or property', async () => {
      await db.update(keywordTargets).set({ isActive: false }).where(eq(keywordTargets.id, targetId));
      expect((await dueTargets()).map((d) => d.target.id)).not.toContain(targetId);
      await db.update(keywordTargets).set({ isActive: true }).where(eq(keywordTargets.id, targetId));

      await db.update(keywords).set({ isActive: false }).where(eq(keywords.id, keywordId));
      expect((await dueTargets()).map((d) => d.target.id)).not.toContain(targetId);
      await db.update(keywords).set({ isActive: true }).where(eq(keywords.id, keywordId));

      await db.update(properties).set({ isActive: false }).where(eq(properties.id, propertyId));
      expect((await dueTargets()).map((d) => d.target.id)).not.toContain(targetId);
      await db.update(properties).set({ isActive: true }).where(eq(properties.id, propertyId));
    });
  });

  /* ── Claiming (found by adversarial review) ───────────────────────────── */

  describe('claimDueTargets', () => {
    it('stamps the claim in the SAME statement that selects', async () => {
      const claimed = await claimDueTargets(1000);
      expect(claimed.map((c) => c.target.id)).toContain(targetId);

      const [after] = await db.select().from(keywordTargets).where(eq(keywordTargets.id, targetId));
      expect(after!.lastEnqueuedAt).toBeInstanceOf(Date);
    });

    it('does not hand the same target to a second caller', async () => {
      await claimDueTargets(1000);
      const second = await claimDueTargets(1000);
      expect(second.map((c) => c.target.id)).not.toContain(targetId);
    });

    it('CONCURRENT claims partition the work rather than duplicating it', async () => {
      /*
       * Select-then-update is a race: two overlapping cron invocations — a
       * scheduler retrying after a 60-second kill, or any at-least-once
       * scheduler — both see the same targets as due and both post them. At 400
       * tracked combinations that is 800 billed tasks instead of 400.
       */
      const [a, b] = await Promise.all([claimDueTargets(1000), claimDueTargets(1000)]);

      const ids = [...a, ...b].map((c) => c.target.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.filter((id) => id === targetId)).toHaveLength(1);
    });

    it('returns the joined keyword and domain, not placeholders', async () => {
      const claimed = await claimDueTargets(1000);
      const mine = claimed.find((c) => c.target.id === targetId);

      expect(mine).toMatchObject({
        term: 'prestige sector 150 noida',
        domain: 'prestigenoidasector150.com',
      });
      expect(mine!.target.locationCode).toBe(1007742);
      expect(mine!.target.device).toBe('mobile');
    });
  });

  /* ── Batching ─────────────────────────────────────────────────────────── */

  describe('enqueueSerpBatch', () => {
    it('batches rather than one request per keyword', async () => {
      // §16 anti-pattern: one task_post per keyword when batching is available.
      const extras = await db
        .insert(keywords)
        .values(
          Array.from({ length: 5 }, (_, i) => ({ propertyId, term: `batch keyword ${i}` })),
        )
        .returning();

      await db.insert(keywordTargets).values(
        extras.map((k) => ({
          keywordId: k.id,
          propertyId,
          locationCode: 2356,
          locationName: 'India',
          device: 'desktop' as const,
        })),
      );

      const client = fakeClient();
      await enqueueSerpBatch({ client, now });

      // dueTargets is deliberately global — other suites' targets may ride
      // along — so assert on OUR six rather than on a global count.
      const mine = await db
        .select({ id: keywordTargets.id })
        .from(keywordTargets)
        .where(eq(keywordTargets.propertyId, propertyId));

      const posted = client.posts.flat().map((t) => t.tag);
      for (const target of mine) expect(posted).toContain(target.id);

      // ONE request carrying all of them, not one request per keyword.
      const firstBatch = client.posts[0]!.map((t) => t.tag);
      for (const target of mine) expect(firstBatch).toContain(target.id);
      expect(client.posts.length).toBeLessThanOrEqual(Math.ceil(posted.length / 100));

      for (const k of extras) await db.delete(keywords).where(eq(keywords.id, k.id));
    });

    /**
     * Find OUR task among the posted batches.
     *
     * `dueTargets` is global and ordered by least-recently-checked, so which
     * position our target lands in depends on what other suites have written.
     * Asserting on `posts[0][0]` makes the test flaky rather than strict.
     */
    const ourTask = (client: ReturnType<typeof fakeClient>) => {
      const task = client.posts.flat().find((t) => t.tag === targetId);
      expect(task, 'our target was not submitted').toBeDefined();
      return task!;
    };

    it('sends the location code from the row, never a hardcoded one', async () => {
      const client = fakeClient();
      await enqueueSerpBatch({ client, now });

      expect(ourTask(client)).toMatchObject({
        location_code: 1007742,
        language_code: 'en',
        device: 'mobile',
        os: 'android',
        depth: 100,
      });
    });

    it('tags each task with the keyword_target_id so the webhook can route it', async () => {
      const client = fakeClient();
      await enqueueSerpBatch({ client, now });
      expect(ourTask(client).tag).toBe(targetId);
    });

    it('derives the os from the device', async () => {
      const client = fakeClient();
      await enqueueSerpBatch({
        client,
        now,
        selectDue: async () => [
          {
            target: { ...(await desktopTarget()) },
            term: 'desktop keyword',
            domain: 'example.com',
          },
        ],
      });

      expect(client.posts[0]![0]).toMatchObject({ device: 'desktop', os: 'windows' });
    });

    it('includes a pingback URL carrying the secret and the $id token', async () => {
      const client = fakeClient();
      await enqueueSerpBatch({ client, now });

      const url = ourTask(client).pingback_url!;
      expect(url).toContain('/api/webhooks/dataforseo');
      expect(url).toContain('secret=');
      expect(url).toMatch(/[?&]id=\$id$/); // DataForSEO substitutes $id
    });

    it('records an ingest_runs row with the estimated spend', async () => {
      const client = fakeClient();
      const result = await enqueueSerpBatch({ client, now });

      // The estimate is exactly the standard-queue price per accepted task.
      expect(result.estimatedCostUsd).toBeCloseTo(result.tasksSubmitted * 0.0006, 9);
      expect(result.tasksSubmitted).toBeGreaterThan(0);

      const [run] = await db
        .select()
        .from(ingestRuns)
        .where(eq(ingestRuns.kind, 'serp_batch'))
        .orderBy(sql`started_at desc`)
        .limit(1);

      expect(run!.status).toBe('success');
      expect(Number(run!.costUsd)).toBeCloseTo(result.estimatedCostUsd, 9);
    });

    it('counts a per-task rejection even when the envelope says 20000', async () => {
      // The dangerous case: HTTP 200, envelope 20000, and one task failed.
      // Counting it as submitted makes a keyword silently stop being tracked.
      const client = fakeClient({
        post: () => clone(taskPostResponse) as unknown as SerpEnvelope,
      });

      // Pinned to one batch: the fixture answers with a fixed two-task
      // envelope, so a second batch would double the counts.
      const [only] = await db
        .select({ target: keywordTargets, term: keywords.term, domain: properties.domain })
        .from(keywordTargets)
        .innerJoin(keywords, eq(keywords.id, keywordTargets.keywordId))
        .innerJoin(properties, eq(properties.id, keywordTargets.propertyId))
        .where(eq(keywordTargets.id, targetId));

      const result = await enqueueSerpBatch({ client, now, selectDue: async () => [only!] });

      expect(result.tasksSubmitted).toBe(1);
      expect(result.tasksRejected).toBe(1);

      const [run] = await db.select().from(ingestRuns).where(eq(ingestRuns.kind, 'serp_batch')).limit(1);
      expect(run!.status).toBe('partial');
    });

    it('does NOT re-submit a target whose pingback never arrived', async () => {
      /*
       * The money leak this closes. last_checked_at only advances when a RESULT
       * lands. If the pingback is lost — a failed task, a misconfigured webhook
       * — the target stays permanently due and is re-submitted and re-billed on
       * every single run, forever, with nothing to show for it.
       */
      const client = fakeClient();
      await enqueueSerpBatch({ client, now });

      const [after] = await db.select().from(keywordTargets).where(eq(keywordTargets.id, targetId));
      expect(after!.lastEnqueuedAt).toBeInstanceOf(Date);
      expect(after!.lastCheckedAt).toBeNull(); // no result came back

      const second = fakeClient();
      await enqueueSerpBatch({ client: second, now });

      expect(second.posts.flat().map((t) => t.tag)).not.toContain(targetId);
    });

    it('does NOT stamp a target the provider rejected — that one cost nothing', async () => {
      const client = fakeClient({
        post: (tasks) => ({
          status_code: 20000,
          tasks: tasks.map((t) => ({
            id: 'x',
            status_code: 40501,
            status_message: "Invalid Field: 'location_code'.",
            cost: 0,
            data: { tag: t.tag },
            result: null,
          })),
        }),
      });

      await enqueueSerpBatch({ client, now });

      const [after] = await db.select().from(keywordTargets).where(eq(keywordTargets.id, targetId));
      // Retried next run, because nothing was spent on it.
      expect(after!.lastEnqueuedAt).toBeNull();
    });

    it('does not re-submit a target that was checked inside its interval', async () => {
      await db
        .update(keywordTargets)
        .set({ lastCheckedAt: new Date() })
        .where(eq(keywordTargets.id, targetId));

      const client = fakeClient();
      await enqueueSerpBatch({ client, now });

      expect(client.posts.flat().map((t) => t.tag)).not.toContain(targetId);
    });

    it('records FAILED when every task was rejected', async () => {
      // DataForSEO down, balance at zero, credentials rotated. A yellow
      // `partial` row hides an outage in which no rank data arrives at all.
      const client = fakeClient({
        post: (tasks) => ({
          status_code: 20000,
          tasks: tasks.map((t) => ({
            id: 'x',
            status_code: 40501,
            status_message: 'rejected',
            cost: 0,
            data: { tag: t.tag },
            result: null,
          })),
        }),
      });

      const result = await enqueueSerpBatch({ client, now });
      expect(result.tasksSubmitted).toBe(0);

      const [run] = await db
        .select()
        .from(ingestRuns)
        .where(eq(ingestRuns.kind, 'serp_batch'))
        .orderBy(sql`started_at desc`)
        .limit(1);

      expect(run!.status).toBe('failed');
    });

    it('releases the claim on a REJECTED task, since it cost nothing', async () => {
      const client = fakeClient({
        post: (tasks) => ({
          status_code: 20000,
          tasks: tasks.map((t) => ({
            id: 'x',
            status_code: 40501,
            status_message: 'rejected',
            cost: 0,
            data: { tag: t.tag },
            result: null,
          })),
        }),
      });

      await enqueueSerpBatch({ client, now });

      const [after] = await db.select().from(keywordTargets).where(eq(keywordTargets.id, targetId));
      expect(after!.lastEnqueuedAt).toBeNull();
    });

    it('submits nothing, and costs nothing, when no target is due', async () => {
      const client = fakeClient();
      const result = await enqueueSerpBatch({ client, now, selectDue: async () => [] });

      expect(result).toMatchObject({
        tasksSubmitted: 0,
        tasksRejected: 0,
        estimatedCostUsd: 0,
        batches: 0,
      });
      expect(client.posts).toHaveLength(0);
    });

    it('splits into multiple requests above the 100-task limit', async () => {
      // §17: task_post accepts at most 100 tasks. A 101st in the same request
      // is rejected outright, so the batch must be chunked.
      const [row] = await db
        .select({ target: keywordTargets, term: keywords.term, domain: properties.domain })
        .from(keywordTargets)
        .innerJoin(keywords, eq(keywords.id, keywordTargets.keywordId))
        .innerJoin(properties, eq(properties.id, keywordTargets.propertyId))
        .where(eq(keywordTargets.id, targetId));

      const many = Array.from({ length: 250 }, () => row!);
      const client = fakeClient();
      const result = await enqueueSerpBatch({ client, now, selectDue: async () => many });

      expect(result.batches).toBe(3);
      expect(client.posts.map((p) => p.length)).toEqual([100, 100, 50]);
      expect(result.tasksSubmitted).toBe(250);
    });
  });

  /* ── Pingback ─────────────────────────────────────────────────────────── */

  describe('handleSerpPingback', () => {
    it('records a check with both rank fields and the competitor list', async () => {
      const client = fakeClient({ get: () => taggedFound(targetId) });
      const outcome = await handleSerpPingback('task-1', { client, now });

      expect(outcome.status).toBe('recorded');

      const [check] = await db.select().from(serpChecks).where(eq(serpChecks.keywordTargetId, targetId));

      expect(check!.found).toBe(true);
      expect(check!.rankGroup).toBe(7);
      expect(check!.rankAbsolute).toBe(13);
      expect(check!.rankingUrl).toBe('https://prestigenoidasector150.com/');
      expect(Array.isArray(check!.competingDomains)).toBe(true);
      expect((check!.competingDomains as unknown[]).length).toBe(10);
      expect(check!.serpFeatures).toMatchObject({ ai_overview: true, paid_count: 2 });
      expect(Number(check!.costUsd)).toBeCloseTo(0.0006, 6);
    });

    /*
     * The real `task_get` shape, which is not what the fixture above carries.
     *
     * DataForSEO bills at `task_post` and serves results free for thirty days,
     * so a genuine `task_get` answers `"cost": 0` — not null. `task.cost ?? …`
     * does not catch a zero, so every scheduled check stored 0.000000 and /ops
     * reported $0.00 month to date while the account was billed for all of it.
     *
     * The assertion above passes only because `live-advanced-found.json` is a
     * LIVE response reused as a task_get answer, and it carries a real cost. The
     * repository's one genuine task_get fixture, `task-get-error.json`, has
     * `"cost": 0` — the accurate shape was already in the tree.
     */
    it('records the list price when the provider reports cost 0, as task_get does', async () => {
      const client = fakeClient({
        get: () => withTaskCost(taggedFound(targetId), 0),
      });

      await handleSerpPingback('task-1', { client, now });

      const [check] = await db.select().from(serpChecks).where(eq(serpChecks.keywordTargetId, targetId));

      // The price we were charged at submission, not the zero task_get reports.
      expect(Number(check!.costUsd)).toBeCloseTo(0.0006, 6);
      expect(Number(check!.costUsd)).toBeGreaterThan(0);
    });

    it('prefers a real cost when the provider does report one', async () => {
      const client = fakeClient({
        get: () => withTaskCost(taggedFound(targetId), 0.0031),
      });

      await handleSerpPingback('task-1', { client, now });

      const [check] = await db.select().from(serpChecks).where(eq(serpChecks.keywordTargetId, targetId));
      expect(Number(check!.costUsd)).toBeCloseTo(0.0031, 6);
    });

    it('stores the provider timestamp, not our receipt time', async () => {
      const client = fakeClient({ get: () => taggedFound(targetId) });
      await handleSerpPingback('task-1', { client, now });

      const [check] = await db.select().from(serpChecks).where(eq(serpChecks.keywordTargetId, targetId));
      expect(check!.checkedAt.toISOString()).toBe('2026-09-12T14:03:22.000Z');
    });

    it('is idempotent — a redelivered pingback does not create a second check', async () => {
      // DataForSEO redelivers whenever we fail to return 200. Stamping our own
      // receipt time would turn each redelivery into a new data point.
      const client = fakeClient({ get: () => taggedFound(targetId) });

      await handleSerpPingback('task-1', { client, now });
      await handleSerpPingback('task-1', { client, now: () => new Date('2026-09-12T15:30:00Z') });

      expect(await countChecks()).toBe(1);
    });

    it('stores exactly one payload per check, even after redelivery', async () => {
      const client = fakeClient({ get: () => taggedFound(targetId) });
      await handleSerpPingback('task-1', { client, now });
      await handleSerpPingback('task-1', { client, now });

      const [check] = await db.select().from(serpChecks).where(eq(serpChecks.keywordTargetId, targetId));
      const payloads = await db
        .select()
        .from(serpPayloads)
        .where(eq(serpPayloads.serpCheckId, check!.id));

      expect(payloads).toHaveLength(1);
    });

    it('stores a TRIMMED payload — organic only, capped, bulk dropped', async () => {
      const client = fakeClient({ get: () => taggedFound(targetId) });
      await handleSerpPingback('task-1', { client, now });

      const [payload] = await db.select().from(serpPayloads).limit(1);
      const stored = payload!.payload as { items: Array<Record<string, unknown>>; item_types: string[] };

      expect(stored.items.length).toBeLessThanOrEqual(20);
      expect(stored.items.every((i) => i.type === 'organic')).toBe(true);
      expect(stored.items[0]).not.toHaveProperty('description');
      // The feature types survive even though the blocks themselves are gone.
      expect(stored.item_types).toContain('ai_overview');
    });

    it('advances last_checked_at so the target is not immediately re-queued', async () => {
      const client = fakeClient({ get: () => taggedFound(targetId) });
      await handleSerpPingback('task-1', { client, now });

      const [target] = await db.select().from(keywordTargets).where(eq(keywordTargets.id, targetId));
      expect(target!.lastCheckedAt?.toISOString()).toBe('2026-09-12T14:03:22.000Z');

      // Ask the due query as of the FIXTURE's instant, not the wall clock.
      // Without this the assertion silently expires: once the real date drifts
      // past the check interval the target is genuinely due again and the test
      // starts failing for a reason that has nothing to do with the code.
      expect((await dueTargets(undefined, { now: now() })).map((d) => d.target.id)).not.toContain(
        targetId,
      );
    });

    it('stores a miss as found=false with NULL ranks, never 100', async () => {
      const envelope = clone(notFoundFixture) as unknown as SerpEnvelope;
      envelope.tasks![0]!.data = { tag: targetId };

      const client = fakeClient({ get: () => envelope });
      await handleSerpPingback('task-miss', { client, now });

      const [check] = await db.select().from(serpChecks).where(eq(serpChecks.keywordTargetId, targetId));

      expect(check!.found).toBe(false);
      expect(check!.rankGroup).toBeNull();
      expect(check!.rankAbsolute).toBeNull();
      // Competitive intelligence survives a miss.
      expect((check!.competingDomains as unknown[]).length).toBe(10);
    });

    it('records a FAILED run when the provider task errored', async () => {
      const client = fakeClient({ get: () => clone(taskGetError) as unknown as SerpEnvelope });
      const outcome = await handleSerpPingback('task-err', { client, now });

      expect(outcome.status).toBe('failed');
      expect(await countChecks()).toBe(0);

      const [run] = await db
        .select()
        .from(ingestRuns)
        .where(eq(ingestRuns.kind, 'serp_batch'))
        .orderBy(sql`started_at desc`)
        .limit(1);
      expect(run!.status).toBe('failed');
    });

    it('ignores a result for a target that no longer exists', async () => {
      const envelope = taggedFound(randomUUID());
      const client = fakeClient({ get: () => envelope });

      const outcome = await handleSerpPingback('task-orphan', { client, now });
      expect(outcome.status).toBe('ignored');
    });

    it('fails loudly when a task carries no tag to route by', async () => {
      const envelope = clone(foundFixture) as unknown as SerpEnvelope;
      envelope.tasks![0]!.data = {};

      const outcome = await handleSerpPingback('task-untagged', {
        client: fakeClient({ get: () => envelope }),
        now,
      });

      expect(outcome.status).toBe('failed');
    });

    it('advances last_checked_at only FORWARD', async () => {
      /*
       * Two tasks for one keyword can be in flight and complete out of order.
       * Writing unconditionally lets the older result rewind the timestamp past
       * the check interval, making the target look due again and starting a
       * slow loop of re-submitting and re-paying for a keyword that is fine.
       */
      const newer = taggedFound(targetId);
      newer.tasks![0]!.result![0]!.datetime = '2026-09-12 14:03:22 +00:00';
      await handleSerpPingback('task-new', { client: fakeClient({ get: () => newer }), now });

      const older = taggedFound(targetId);
      older.tasks![0]!.result![0]!.datetime = '2026-09-12 10:00:00 +00:00';
      await handleSerpPingback('task-old', { client: fakeClient({ get: () => older }), now });

      const [target] = await db.select().from(keywordTargets).where(eq(keywordTargets.id, targetId));
      expect(target!.lastCheckedAt?.toISOString()).toBe('2026-09-12T14:03:22.000Z');

      // Both checks are still stored — only the pointer is monotonic.
      expect(await countChecks()).toBe(2);
    });

    it('reports inserted=false on a redelivery, exactly', async () => {
      // M7 suppresses duplicate alerts on this flag. The old heuristic compared
      // created_at against a 60-second window, so a redelivery 20 seconds later
      // reported a fresh insert and would have fired a second rank-drop alert.
      const client = fakeClient({ get: () => taggedFound(targetId) });

      const first = await handleSerpPingback('task-1', { client, now });
      const second = await handleSerpPingback('task-1', { client, now });

      expect(first.status).toBe('recorded');
      expect(second.status).toBe('recorded');
      expect(await countChecks()).toBe(1);
    });

    it('is idempotent even when the provider omits its own timestamp', async () => {
      /*
       * With no `datetime`, receipt time would be the natural key — and receipt
       * time differs on every redelivery, storing one SERP as several data
       * points. The provider task id is stable, so a redelivery finds its own
       * earlier row.
       */
      const envelope = taggedFound(targetId);
      delete envelope.tasks![0]!.result![0]!.datetime;
      envelope.tasks![0]!.id = 'stable-task-id';

      const client = fakeClient({ get: () => envelope });

      await handleSerpPingback('stable-task-id', { client, now: () => new Date('2026-09-12T15:00:00Z') });
      await handleSerpPingback('stable-task-id', { client, now: () => new Date('2026-09-12T15:40:00Z') });

      expect(await countChecks()).toBe(1);
    });

    it('stores exactly one payload even under CONCURRENT redelivery', async () => {
      // Delete-then-insert with no transaction: both deliveries find nothing to
      // delete and both insert. A unique constraint makes that unrepresentable.
      const client = fakeClient({ get: () => taggedFound(targetId) });

      await Promise.all([
        handleSerpPingback('task-1', { client, now }),
        handleSerpPingback('task-1', { client, now }),
        handleSerpPingback('task-1', { client, now }),
      ]);

      const [check] = await db.select().from(serpChecks).where(eq(serpChecks.keywordTargetId, targetId));
      const payloads = await db
        .select()
        .from(serpPayloads)
        .where(eq(serpPayloads.serpCheckId, check!.id));

      expect(payloads).toHaveLength(1);
    });

    it('does not throw when task_get itself fails', async () => {
      // The route must still return 200, or DataForSEO redelivers forever.
      const client = fakeClient({
        get: () => Object.assign(new Error('upstream'), { status: 500 }),
      });

      await expect(handleSerpPingback('task-boom', { client, now })).resolves.toMatchObject({
        status: 'failed',
      });
    });
  });

  /* ── Live check ───────────────────────────────────────────────────────── */

  describe('liveCheckTarget', () => {
    it('records a check marked as the live provider', async () => {
      const client = fakeClient({ live: () => taggedFound(targetId) });
      const result = await liveCheckTarget(targetId, { client, now });

      expect(result.status).toBe('ok');

      const [check] = await db.select().from(serpChecks).where(eq(serpChecks.keywordTargetId, targetId));
      expect(check!.provider).toBe('dataforseo-live');
      expect(check!.rankGroup).toBe(7);
    });

    it('rate-limits a second call inside the cooldown', async () => {
      const client = fakeClient({ live: () => taggedFound(targetId) });
      await liveCheckTarget(targetId, { client, now });

      const second = await liveCheckTarget(targetId, { client, now });

      expect(second.status).toBe('rate_limited');
      expect(client.lives).toHaveLength(1); // no second billed call
    });

    it('claims the cooldown ATOMICALLY — concurrent presses cannot both pay', async () => {
      /*
       * A read-then-act check is a race: two simultaneous presses both read "no
       * recent check" and both spend $0.0020. A single conditional UPDATE
       * cannot race, and the Neon HTTP driver has no transaction to reach for.
       */
      await db
        .update(keywordTargets)
        .set({ lastLiveCheckAt: null })
        .where(eq(keywordTargets.id, targetId));

      const client = fakeClient({ live: () => taggedFound(targetId) });

      const results = await Promise.all([
        liveCheckTarget(targetId, { client, now }),
        liveCheckTarget(targetId, { client, now }),
        liveCheckTarget(targetId, { client, now }),
      ]);

      const paid = results.filter((r) => r.status !== 'rate_limited');
      expect(paid).toHaveLength(1);
      expect(client.lives).toHaveLength(1);
    });

    it('allows another call once the cooldown has elapsed', async () => {
      /*
       * The cooldown is claimed with a conditional UPDATE against the DATABASE
       * clock, which is what makes it atomic — so it deliberately ignores the
       * injected clock. Ageing the stored timestamp is the honest way to
       * simulate elapsed time here.
       */
      const client = fakeClient({ live: () => taggedFound(targetId) });
      await liveCheckTarget(targetId, { client, now });

      await db
        .update(keywordTargets)
        .set({ lastLiveCheckAt: new Date(Date.now() - LIVE_CHECK_COOLDOWN_MS - 1000) })
        .where(eq(keywordTargets.id, targetId));

      const second = await liveCheckTarget(targetId, { client, now });
      expect(second.status).not.toBe('rate_limited');
    });

    it('is NOT rate-limited by a scheduled check', async () => {
      // last_checked_at moves on every pingback. Keying the cooldown off it
      // would let scheduled traffic consume the user's manual allowance.
      const pingbackClient = fakeClient({ get: () => taggedFound(targetId) });
      await handleSerpPingback('task-1', { client: pingbackClient, now });

      const liveClient = fakeClient({ live: () => taggedFound(targetId) });
      const result = await liveCheckTarget(targetId, { client: liveClient, now });

      expect(result.status).not.toBe('rate_limited');
    });

    it('reports a failure rather than throwing when the provider errors', async () => {
      const client = fakeClient({ live: () => Object.assign(new Error('nope'), { status: 402 }) });
      await expect(liveCheckTarget(targetId, { client, now })).resolves.toMatchObject({
        status: 'failed',
      });
    });

    it('reports a failure for an unknown target', async () => {
      await expect(
        liveCheckTarget(randomUUID(), { client: fakeClient(), now }),
      ).resolves.toMatchObject({ status: 'failed' });
    });
  });

  /* ── Spend reconciliation (acceptance criterion 9) ────────────────────── */

  it('sums serp_checks.cost_usd to the authoritative month-to-date figure', async () => {
    const client = fakeClient({ get: () => taggedFound(targetId) });
    await handleSerpPingback('task-1', { client, now });

    const [sum] = await db
      .select({ total: sql<string>`coalesce(sum(${serpChecks.costUsd}), 0)::text` })
      .from(serpChecks)
      .where(and(eq(serpChecks.propertyId, propertyId)));

    expect(Number(sum!.total)).toBeCloseTo(0.0006, 6);
  });
});
