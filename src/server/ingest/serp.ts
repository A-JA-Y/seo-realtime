import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';

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
    selectDue: overrides.selectDue ?? dueTargets,
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
        or(
          isNull(keywordTargets.lastCheckedAt),
          lt(
            keywordTargets.lastCheckedAt,
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

        for (const task of envelope.tasks ?? []) {
          if (isTaskOk(task.status_code)) {
            submitted++;
            continue;
          }

          // The envelope can be 20000 while an individual task failed — a bad
          // location_code, say. Counting those as submitted would make a
          // keyword silently stop being tracked.
          rejected++;
          run.markPartial(
            `task rejected (${task.status_code}): ${task.status_message ?? 'no message'}`,
          );
          run.log.warn('task rejected by provider', {
            status_code: task.status_code,
            status_message: task.status_message,
            keyword_target_id: task.data?.tag,
          });
        }
      } catch (error) {
        rejected += chunk.length;
        run.markPartial(`batch failed: ${redactError(error)}`);
        run.log.error('task_post batch failed', {
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
  const checkedAt = parsed.checkedAt ?? options.receivedAt;

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
    .returning({ id: serpChecks.id, createdAt: serpChecks.createdAt });

  if (!row) throw new Error('failed to write serp_checks row');

  // Payloads live in their own table so retention can prune them without
  // touching the time series (§6). One payload per check, replaced on re-run.
  await db.delete(serpPayloads).where(eq(serpPayloads.serpCheckId, row.id));
  await db.insert(serpPayloads).values({ serpCheckId: row.id, payload: options.trimmedPayload });

  await db
    .update(keywordTargets)
    .set({ lastCheckedAt: checkedAt })
    .where(eq(keywordTargets.id, target.id));

  return {
    serpCheckId: row.id,
    checkedAt,
    inserted: row.createdAt.getTime() >= options.receivedAt.getTime() - 60_000,
  };
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
   * The cooldown is derived from the last LIVE check, not from
   * last_checked_at — that moves on every scheduled pingback too, so using it
   * would let a scheduled check silently consume the user's manual allowance.
   */
  const [recent] = await db
    .select({ checkedAt: serpChecks.checkedAt })
    .from(serpChecks)
    .where(
      and(
        eq(serpChecks.keywordTargetId, keywordTargetId),
        eq(serpChecks.provider, 'dataforseo-live'),
      ),
    )
    .orderBy(sql`${serpChecks.checkedAt} desc`)
    .limit(1);

  if (recent) {
    const elapsed = at.getTime() - recent.checkedAt.getTime();
    if (elapsed < LIVE_CHECK_COOLDOWN_MS) {
      return { status: 'rate_limited', retryAfterMs: LIVE_CHECK_COOLDOWN_MS - elapsed };
    }
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
