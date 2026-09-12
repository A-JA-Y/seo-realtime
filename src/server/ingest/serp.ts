import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';

import { env } from '@/lib/env';
import type { Logger } from '@/lib/logger';
import { redactError } from '@/lib/redact';
import { db } from '@/server/db';
import {
  keywordTargets,
  keywords,
  properties,
  serpChecks,
  serpPayloads,
  type KeywordTarget,
  type Property,
} from '@/server/db/schema';
import {
  COST_PER_SERP,
  MAX_TASKS_PER_POST,
  buildPingbackUrl,
  createDataForSeoClient,
  isTaskOk,
  type DataForSeoClient,
  type SerpTaskRequest,
} from './dataforseo-client';
import {
  parseSerpResult,
  serpEnvelopeSchema,
  trimSerpPayload,
  type ParsedSerp,
} from './serp-parse';
import { withIngestRun, type RunHandle } from './runs';

/**
 * DataForSEO ingestion (§6).
 *
 * Scheduled work goes through the STANDARD queue and returns by pingback.
 * Polling `task_get` in a loop inside a serverless function is an explicit
 * anti-pattern (§16) — it burns invocation time waiting on a queue, and on
 * Hobby the function is killed at 60 seconds anyway.
 */

export interface SerpDeps {
  client?: DataForSeoClient;
  now?: () => Date;
  /**
   * Override the due-target selection.
   *
   * `dueTargets` is deliberately global — one batched POST covers every
   * property, which is the whole point of batching — so a test cannot isolate
   * it by scoping to a property. This seam lets the empty and
   * over-one-batch branches be exercised deterministically.
   */
  selectDue?: (limit: number) => Promise<DueTarget[]>;
}

function deps(overrides: SerpDeps = {}) {
  return {
    client: overrides.client ?? createDataForSeoClient(),
    now: overrides.now ?? (() => new Date()),
    // Claims before posting. `dueTargets` is the read-only view, used by the
    // /ops page and by tests that want to inspect selection without stamping.
    selectDue: overrides.selectDue ?? claimDueTargets,
  };
}

/** A target joined to the two rows the request needs. */
export interface DueTarget {
  target: KeywordTarget;
  term: string;
  domain: string;
}

/**
 * Targets whose check interval has elapsed.
 *
 * The comparison runs in SQL against `now()` so it cannot drift with the
 * function's clock, and `check_interval_min` is per target — §13's cost levers
 * depend on being able to check a money keyword hourly and a long-tail one
 * twice a day.
 */
export async function dueTargets(limit = MAX_TASKS_PER_POST): Promise<DueTarget[]> {
  const rows = await db
    .select({
      target: keywordTargets,
      term: keywords.term,
      domain: properties.domain,
    })
    .from(keywordTargets)
    .innerJoin(keywords, eq(keywords.id, keywordTargets.keywordId))
    .innerJoin(properties, eq(properties.id, keywordTargets.propertyId))
    .where(
      and(
        eq(keywordTargets.isActive, true),
        eq(keywords.isActive, true),
        eq(properties.isActive, true),
        // A result has not landed inside the interval...
        or(
          isNull(keywordTargets.lastCheckedAt),
          lt(
            keywordTargets.lastCheckedAt,
            sql`now() - (${keywordTargets.checkIntervalMin} * interval '1 minute')`,
          ),
        ),
        /*
         * ...AND we have not already paid for one inside the interval.
         *
         * Submission is what costs money; a result may never arrive. Without
         * this clause a target whose pingback is lost — a task the provider
         * failed, a misconfigured webhook — stays permanently due and is
         * re-submitted and re-billed on EVERY run, forever, with nothing to
         * show for it. Gating on the same interval means an unhealthy target
         * costs exactly its intended cadence and no more.
         */
        or(
          isNull(keywordTargets.lastEnqueuedAt),
          lt(
            keywordTargets.lastEnqueuedAt,
            sql`now() - (${keywordTargets.checkIntervalMin} * interval '1 minute')`,
          ),
        ),
      ),
    )
    // Least-recently-checked first, so a target can never be starved by a
    // batch that repeatedly happens to select the same rows.
    .orderBy(sql`${keywordTargets.lastCheckedAt} asc nulls first`)
    .limit(limit);

  return rows;
}

function toTaskRequest(due: DueTarget, pingbackUrl: string): SerpTaskRequest {
  return {
    keyword: due.term,
    // Read from the row, never hardcoded (§16). A stale code silently returns
    // rankings for the wrong geography.
    location_code: due.target.locationCode,
    language_code: due.target.languageCode,
    device: due.target.device,
    os: due.target.device === 'mobile' ? 'android' : 'windows',
    depth: 100,
    // Carries the target id so the webhook routes without a lookup table.
    tag: due.target.id,
    pingback_url: pingbackUrl,
  };
}

export interface EnqueueResult {
  tasksSubmitted: number;
  tasksRejected: number;
  estimatedCostUsd: number;
  batches: number;
}

/**
 * Atomically claim the targets this run will pay for.
 *
 * One statement: select what is due and stamp `last_enqueued_at` in the same
 * breath, returning only the rows this invocation actually won. A select
 * followed by a separate update is a race — two overlapping cron invocations
 * (a scheduler retrying after a 60-second kill, or any at-least-once scheduler)
 * both see the same targets as due and both post them. At 400 tracked
 * combinations that is 800 billed tasks instead of 400, every time it happens.
 *
 * `FOR UPDATE SKIP LOCKED` means a concurrent run takes different rows rather
 * than blocking on these — so two overlapping runs split the work instead of
 * duplicating it.
 */
export async function claimDueTargets(limit = MAX_TASKS_PER_POST): Promise<DueTarget[]> {
  const result = await db.execute<{
    id: string;
    keyword_id: string;
    property_id: string;
    location_code: number;
    location_name: string;
    language_code: string;
    device: 'desktop' | 'mobile';
    check_interval_min: number;
    term: string;
    domain: string;
  }>(sql`
    WITH due AS (
      SELECT kt.id
      FROM keyword_targets kt
      JOIN keywords k   ON k.id = kt.keyword_id
      JOIN properties p ON p.id = kt.property_id
      WHERE kt.is_active AND k.is_active AND p.is_active
        AND (kt.last_checked_at IS NULL
             OR kt.last_checked_at < now() - (kt.check_interval_min * interval '1 minute'))
        AND (kt.last_enqueued_at IS NULL
             OR kt.last_enqueued_at < now() - (kt.check_interval_min * interval '1 minute'))
      ORDER BY kt.last_checked_at ASC NULLS FIRST
      LIMIT ${limit}
      FOR UPDATE OF kt SKIP LOCKED
    ),
    claimed AS (
      UPDATE keyword_targets kt
      SET last_enqueued_at = now()
      WHERE kt.id IN (SELECT id FROM due)
      RETURNING kt.*
    )
    SELECT
      c.id, c.keyword_id, c.property_id, c.location_code, c.location_name,
      c.language_code, c.device, c.check_interval_min, k.term, p.domain
    FROM claimed c
    JOIN keywords k   ON k.id = c.keyword_id
    JOIN properties p ON p.id = c.property_id
  `);

  return result.rows.map((row) => ({
    target: {
      id: row.id,
      keywordId: row.keyword_id,
      propertyId: row.property_id,
      locationCode: row.location_code,
      locationName: row.location_name,
      languageCode: row.language_code,
      device: row.device,
      checkIntervalMin: row.check_interval_min,
      isActive: true,
      lastCheckedAt: null,
      lastEnqueuedAt: null,
      lastLiveCheckAt: null,
      createdAt: new Date(0),
    },
    term: row.term,
    domain: row.domain,
  }));
}

/**
 * Submit every due target, batched (§6).
 *
 * One `task_post` per keyword works and is an explicit anti-pattern: 100 tasks
 * fit in a single request, and at 400 tracked combinations that is 4 requests
 * instead of 400.
 */
export async function enqueueSerpBatch(overrides: SerpDeps = {}): Promise<EnqueueResult> {
  const { client, selectDue } = deps(overrides);

  const outcome = await withIngestRun({ kind: 'serp_batch' }, async (run) => {
    const due = await selectDue(MAX_TASKS_PER_POST * 4);

    if (due.length === 0) {
      run.log.info('no targets due');
      return { tasksSubmitted: 0, tasksRejected: 0, estimatedCostUsd: 0, batches: 0 };
    }

    const pingbackUrl = buildPingbackUrl(env.APP_BASE_URL, env.DATAFORSEO_PINGBACK_SECRET);

    let submitted = 0;
    let rejected = 0;
    let batches = 0;

    for (let offset = 0; offset < due.length; offset += MAX_TASKS_PER_POST) {
      const chunk = due.slice(offset, offset + MAX_TASKS_PER_POST);
      batches++;

      try {
        const envelope = await client.taskPost(chunk.map((d) => toTaskRequest(d, pingbackUrl)));

        const rejectedTags: string[] = [];

        for (const task of envelope.tasks ?? []) {
          if (isTaskOk(task.status_code)) {
            submitted++;
            continue;
          }

          // The envelope can be 20000 while an individual task failed — a bad
          // location_code, say. Counting those as submitted would make a
          // keyword silently stop being tracked.
          rejected++;
          const tag = task.data?.tag;
          if (typeof tag === 'string') rejectedTags.push(tag);
          run.markPartial(
            `task rejected (${task.status_code}): ${task.status_message ?? 'no message'}`,
          );
          run.log.warn('task rejected by provider', {
            status_code: task.status_code,
            status_message: task.status_message,
            keyword_target_id: task.data?.tag,
          });
        }
        /*
         * Release the claim on tasks the provider REJECTED. Those cost nothing,
         * so holding the claim would delay them by a whole check interval for
         * no reason. Accepted tasks keep their claim — they were billed.
         *
         * In its own try: the batch is already submitted and billed, so a
         * failure here is a bookkeeping problem, not a batch failure. Counting
         * it as one would double-count this chunk.
         */
        if (rejectedTags.length > 0) {
          try {
            await db
              .update(keywordTargets)
              .set({ lastEnqueuedAt: null })
              .where(inArray(keywordTargets.id, rejectedTags));
          } catch (error) {
            run.log.warn('could not release the claim on rejected tasks', {
              rejected: rejectedTags.length,
              error: redactError(error),
            });
          }
        }
      } catch (error) {
        rejected += chunk.length;
        run.markPartial(`batch failed: ${redactError(error)}`);
        /*
         * The claim is deliberately NOT released here. A failed POST is
         * ambiguous — a 502 or a reset can arrive after the provider accepted
         * and billed the batch — so releasing would risk paying twice. Holding
         * costs at most one skipped interval for these targets.
         */
        run.log.error('task_post batch failed; claims held to avoid double-billing', {
          batch: batches,
          tasks: chunk.length,
          error: redactError(error),
        });
      }
    }

    /*
     * Cost is ESTIMATED here and reconciled later.
     *
     * task_post bills on acceptance but reports the definitive per-task cost on
     * task_get, which arrives by pingback minutes later. /ops sums
     * serp_checks.cost_usd for the authoritative figure (acceptance criterion
     * 9); this number exists so a runaway batch is visible immediately rather
     * than five minutes later.
     */
    /*
     * A run that submitted nothing at all is an outage — DataForSEO down, the
     * balance at zero, credentials rotated — not a degradation. Recording it as
     * `partial` puts a yellow row on /ops where there should be a red one,
     * while rank data silently stops arriving for every keyword.
     */
    if (submitted === 0 && rejected > 0) {
      run.markFailed(`every task was rejected or failed (${rejected})`);
    }

    const estimatedCostUsd = submitted * COST_PER_SERP.standard;
    run.addCost(estimatedCostUsd);
    run.setMeta({
      targets_due: due.length,
      tasks_submitted: submitted,
      tasks_rejected: rejected,
      batches,
      estimated_cost_usd: estimatedCostUsd,
      queue: 'standard',
    });

    run.log.info('serp batch submitted', {
      tasks_submitted: submitted,
      tasks_rejected: rejected,
      batches,
      estimated_cost_usd: estimatedCostUsd,
    });

    return { tasksSubmitted: submitted, tasksRejected: rejected, estimatedCostUsd, batches };
  });

  return outcome.result;
}

/* ══════════════════════════════════════════════════════════════════════════
   Writing a completed check
   ══════════════════════════════════════════════════════════════════════════ */

export interface RecordCheckOptions {
  target: KeywordTarget;
  property: Pick<Property, 'domain'>;
  parsed: ParsedSerp;
  trimmedPayload: unknown;
  provider: string;
  providerTaskId: string | null;
  costUsd: number | null;
  receivedAt: Date;
  log?: Logger;
}

export interface RecordCheckResult {
  serpCheckId: number;
  checkedAt: Date;
  inserted: boolean;
}

/**
 * Write one `serp_checks` row plus its trimmed payload, idempotently.
 *
 * `checked_at` is the PROVIDER's timestamp where it gave one. That is what
 * makes the natural key stable: DataForSEO redelivers a pingback whenever we
 * fail to return 200, and stamping our own receipt time would turn each
 * redelivery into a new data point for the same SERP.
 */
export async function recordSerpCheck(options: RecordCheckOptions): Promise<RecordCheckResult> {
  const { target, parsed } = options;

  /*
   * When the provider gives no `datetime`, fall back to the timestamp we
   * already stored for this task rather than to the current instant.
   *
   * Receipt time is not stable across redeliveries, so using it would store the
   * same SERP two or three times as separate data points — inflating check
   * counts, spend attribution and any movement the alert engine computes. The
   * provider task id IS stable, so a redelivery finds its own earlier row.
   */
  let checkedAt = parsed.checkedAt;

  if (!checkedAt && options.providerTaskId) {
    const [existing] = await db
      .select({ checkedAt: serpChecks.checkedAt })
      .from(serpChecks)
      .where(
        and(
          eq(serpChecks.keywordTargetId, target.id),
          eq(serpChecks.providerTaskId, options.providerTaskId),
        ),
      )
      .limit(1);

    checkedAt = existing?.checkedAt ?? null;
  }

  checkedAt ??= options.receivedAt;

  const [row] = await db
    .insert(serpChecks)
    .values({
      keywordTargetId: target.id,
      propertyId: target.propertyId,
      keywordId: target.keywordId,
      checkedAt,
      found: parsed.found,
      rankGroup: parsed.rankGroup,
      rankAbsolute: parsed.rankAbsolute,
      rankingUrl: parsed.rankingUrl,
      allRankingUrls: parsed.allRankingUrls,
      competingDomains: parsed.competingDomains,
      serpFeatures: parsed.serpFeatures,
      organicResultCount: parsed.organicResultCount,
      searchDepth: 100,
      provider: options.provider,
      providerTaskId: options.providerTaskId,
      costUsd: options.costUsd === null ? null : options.costUsd.toFixed(6),
    })
    .onConflictDoUpdate({
      target: [serpChecks.keywordTargetId, serpChecks.checkedAt],
      set: {
        found: sql`excluded.found`,
        rankGroup: sql`excluded.rank_group`,
        rankAbsolute: sql`excluded.rank_absolute`,
        rankingUrl: sql`excluded.ranking_url`,
        allRankingUrls: sql`excluded.all_ranking_urls`,
        competingDomains: sql`excluded.competing_domains`,
        serpFeatures: sql`excluded.serp_features`,
        organicResultCount: sql`excluded.organic_result_count`,
        providerTaskId: sql`excluded.provider_task_id`,
        costUsd: sql`excluded.cost_usd`,
      },
    })
    /*
     * `xmax = 0` is Postgres's own answer to "was this an INSERT or an UPDATE":
     * a freshly inserted tuple has no updating transaction id. The previous
     * heuristic — comparing created_at against a 60-second window — reported a
     * redelivery arriving 20 seconds later as a fresh insert, which is exactly
     * the case M7's alert engine must not fire twice on.
     */
    .returning({
      id: serpChecks.id,
      inserted: sql<boolean>`(xmax = 0)`,
    });

  if (!row) throw new Error('failed to write serp_checks row');

  /*
   * Payloads live in their own table so retention can prune them without
   * touching the time series (§6). Upserted, not deleted-then-inserted: without
   * a transaction, two concurrent redeliveries of the same task would both find
   * nothing to delete and both insert.
   */
  await db
    .insert(serpPayloads)
    .values({ serpCheckId: row.id, payload: options.trimmedPayload })
    .onConflictDoUpdate({
      target: serpPayloads.serpCheckId,
      set: { payload: sql`excluded.payload`, createdAt: sql`now()` },
    });

  /*
   * Advance `last_checked_at` only FORWARD.
   *
   * Two tasks for one keyword can be in flight at once — a scheduler overlap,
   * a provider retry — and they can complete out of order. Writing
   * unconditionally lets the older result rewind the timestamp past the check
   * interval, which makes the target look due again and starts a slow loop of
   * re-submitting and re-paying for a keyword that is perfectly up to date.
   */
  await db
    .update(keywordTargets)
    .set({ lastCheckedAt: checkedAt })
    .where(
      and(
        eq(keywordTargets.id, target.id),
        or(isNull(keywordTargets.lastCheckedAt), lt(keywordTargets.lastCheckedAt, checkedAt)),
      ),
    );

  return { serpCheckId: row.id, checkedAt, inserted: row.inserted };
}

/* ══════════════════════════════════════════════════════════════════════════
   Pingback handling
   ══════════════════════════════════════════════════════════════════════════ */

export type PingbackOutcome =
  | { status: 'recorded'; serpCheckId: number; keywordTargetId: string; found: boolean }
  | { status: 'ignored'; reason: string }
  | { status: 'failed'; reason: string };

/**
 * Handle one completed task (§6).
 *
 * Every outcome is a 200 to DataForSEO — including failure. The provider
 * retries a non-200 pingback indefinitely, so a parse bug would become a
 * permanent redelivery loop. Failures are recorded as a `failed` ingest_runs
 * row instead, where /ops can see them.
 */
export async function handleSerpPingback(
  taskId: string,
  overrides: SerpDeps = {},
): Promise<PingbackOutcome> {
  const { client, now } = deps(overrides);
  const receivedAt = now();

  const outcome = await withIngestRun({ kind: 'serp_batch', meta: { pingback_task_id: taskId } }, async (run) => {
    const envelope = serpEnvelopeSchema.parse(await client.taskGetAdvanced(taskId));
    const task = envelope.tasks?.[0];

    if (!task) return failure(run, 'response contained no task');

    if (!isTaskOk(task.status_code)) {
      // A provider-side failure is not our bug, but it IS a keyword that did
      // not get checked, and silence is how that goes unnoticed.
      return failure(
        run,
        `provider task failed (${task.status_code}): ${task.status_message ?? 'no message'}`,
      );
    }

    const targetId = task.data?.tag;
    if (!targetId) return failure(run, 'task carried no tag, so it cannot be routed to a target');

    const [joined] = await db
      .select({ target: keywordTargets, domain: properties.domain })
      .from(keywordTargets)
      .innerJoin(properties, eq(properties.id, keywordTargets.propertyId))
      .where(eq(keywordTargets.id, targetId))
      .limit(1);

    if (!joined) {
      // A target deleted between submission and delivery. Not an error — just
      // a result with nowhere to go.
      run.log.info('pingback for an unknown target; discarding', { keyword_target_id: targetId });
      return { status: 'ignored', reason: 'unknown keyword_target_id' } as const;
    }

    const result = task.result?.[0];
    if (!result) return failure(run, 'task completed with no result');

    const parsed = parseSerpResult(result, joined.domain);

    const recorded = await recordSerpCheck({
      target: joined.target,
      property: { domain: joined.domain },
      parsed,
      trimmedPayload: trimSerpPayload(result),
      provider: 'dataforseo',
      providerTaskId: task.id ?? taskId,
      costUsd: task.cost ?? null,
      receivedAt,
      log: run.log,
    });

    run.addRows(1);
    run.addCost(task.cost ?? 0);
    run.setMeta({
      keyword_target_id: joined.target.id,
      found: parsed.found,
      rank_group: parsed.rankGroup,
      rank_absolute: parsed.rankAbsolute,
    });

    run.log.info('serp check recorded', {
      keyword_target_id: joined.target.id,
      found: parsed.found,
      rank_group: parsed.rankGroup,
      rank_absolute: parsed.rankAbsolute,
      furniture_gap:
        parsed.rankAbsolute !== null && parsed.rankGroup !== null
          ? parsed.rankAbsolute - parsed.rankGroup
          : null,
    });

    // M7 runs the alert engine here. Deliberately a seam rather than a stub:
    // an empty function that looks wired up is worse than an obvious gap.

    return {
      status: 'recorded',
      serpCheckId: recorded.serpCheckId,
      keywordTargetId: joined.target.id,
      found: parsed.found,
    } as const;
  }).catch((error: unknown) => ({
    // withIngestRun rethrows after recording; the route must still return 200.
    result: { status: 'failed', reason: redactError(error) } as const,
  }));

  return outcome.result;
}

function failure(run: RunHandle, reason: string): PingbackOutcome {
  run.markFailed(reason);
  run.log.error('pingback could not be processed', { reason });
  return { status: 'failed', reason };
}

/* ══════════════════════════════════════════════════════════════════════════
   Live "check now"
   ══════════════════════════════════════════════════════════════════════════ */

/** §10: "rate-limited 1/5min/keyword". It costs real money per call. */
export const LIVE_CHECK_COOLDOWN_MS = 5 * 60 * 1000;

export type LiveCheckResult =
  | { status: 'ok'; serpCheckId: number; parsed: ParsedSerp; costUsd: number | null }
  | { status: 'rate_limited'; retryAfterMs: number }
  | { status: 'failed'; reason: string };

/**
 * Synchronous check for the dashboard's "check now" button.
 *
 * Live mode is 3.3x the standard queue ($0.0020 vs $0.0006) and is used ONLY
 * here, where a person is waiting. Scheduled work has no use for a six-second
 * turnaround.
 */
export async function liveCheckTarget(
  keywordTargetId: string,
  overrides: SerpDeps = {},
): Promise<LiveCheckResult> {
  const { client, now } = deps(overrides);
  const at = now();

  const [joined] = await db
    .select({ target: keywordTargets, term: keywords.term, domain: properties.domain })
    .from(keywordTargets)
    .innerJoin(keywords, eq(keywords.id, keywordTargets.keywordId))
    .innerJoin(properties, eq(properties.id, keywordTargets.propertyId))
    .where(eq(keywordTargets.id, keywordTargetId))
    .limit(1);

  if (!joined) return { status: 'failed', reason: 'unknown keyword target' };

  /*
   * Claim the cooldown ATOMICALLY, before spending anything.
   *
   * A read-then-act check is a race: two simultaneous button presses both read
   * "no recent check" and both pay $0.0020. A single conditional UPDATE cannot
   * race — Postgres serialises the row — and the Neon HTTP driver has no
   * interactive transactions to reach for instead.
   *
   * Keyed on its own column rather than on `last_checked_at`, which moves on
   * every scheduled pingback too and would let routine traffic silently consume
   * the user's manual allowance.
   */
  const claimed = await db
    .update(keywordTargets)
    .set({ lastLiveCheckAt: sql`now()` })
    .where(
      and(
        eq(keywordTargets.id, keywordTargetId),
        or(
          isNull(keywordTargets.lastLiveCheckAt),
          lt(
            keywordTargets.lastLiveCheckAt,
            sql`now() - (${LIVE_CHECK_COOLDOWN_MS} * interval '1 millisecond')`,
          ),
        ),
      ),
    )
    .returning({ id: keywordTargets.id });

  if (claimed.length === 0) {
    const elapsed = joined.target.lastLiveCheckAt
      ? at.getTime() - joined.target.lastLiveCheckAt.getTime()
      : 0;
    return {
      status: 'rate_limited',
      retryAfterMs: Math.max(0, LIVE_CHECK_COOLDOWN_MS - elapsed),
    };
  }

  try {
    const envelope = await client.liveAdvanced({
      keyword: joined.term,
      location_code: joined.target.locationCode,
      language_code: joined.target.languageCode,
      device: joined.target.device,
      os: joined.target.device === 'mobile' ? 'android' : 'windows',
      depth: 100,
      tag: joined.target.id,
    });

    const task = envelope.tasks?.[0];
    if (!task || !isTaskOk(task.status_code)) {
      return {
        status: 'failed',
        reason: `provider returned ${task?.status_code ?? 'no task'}: ${task?.status_message ?? ''}`.trim(),
      };
    }

    const result = task.result?.[0];
    if (!result) return { status: 'failed', reason: 'live call returned no result' };

    const parsed = parseSerpResult(result, joined.domain);

    const recorded = await recordSerpCheck({
      target: joined.target,
      property: { domain: joined.domain },
      parsed,
      trimmedPayload: trimSerpPayload(result),
      provider: 'dataforseo-live',
      providerTaskId: task.id ?? null,
      costUsd: task.cost ?? COST_PER_SERP.live,
      receivedAt: at,
    });

    return {
      status: 'ok',
      serpCheckId: recorded.serpCheckId,
      parsed,
      costUsd: task.cost ?? COST_PER_SERP.live,
    };
  } catch (error) {
    return { status: 'failed', reason: redactError(error) };
  }
}
