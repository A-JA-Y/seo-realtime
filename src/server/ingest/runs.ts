import { eq, sql } from 'drizzle-orm';

import { createLogger, logger as rootLogger, type Logger } from '@/lib/logger';
import { redactError } from '@/lib/redact';
import { db } from '@/server/db';
import { ingestRuns, type IngestKind, type IngestStatus } from '@/server/db/schema';

/**
 * Every job wraps its work in an `ingest_runs` row (§7).
 *
 * That row is the only durable record that a scheduled job ran at all. §12
 * calls silent ingest death the most likely serious failure mode, and it is
 * silent precisely because a job that never starts logs nothing. A `running`
 * row written before the work begins turns "no data" into "started at 04:00,
 * never finished", which is a diagnosable state.
 */

export interface RunHandle {
  readonly id: string;
  /** Child logger already carrying run_id, job and property_id. */
  readonly log: Logger;
  /** Accumulate rows written. Reported on the run row and in the final log line. */
  addRows(count: number): void;
  /** Accumulate spend in USD. DataForSEO only; Search Console is free. */
  addCost(usd: number): void;
  /** Merge fields into the run's `meta` JSON. */
  setMeta(patch: Record<string, unknown>): void;
  /**
   * Mark the run as partially successful: some units of work failed, but the
   * job as a whole did useful work and must not be treated as a failure.
   */
  markPartial(reason: string): void;
  /**
   * Mark the run as failed without throwing.
   *
   * For a job that completed its own control flow but achieved nothing — every
   * keyword errored, say. Reporting that as `partial` would make an outage look
   * like a degradation, and /ops would show a warning where it should show a
   * failure.
   */
  markFailed(reason: string): void;
  rowsWritten(): number;
}

export interface RunOptions {
  kind: IngestKind;
  propertyId?: string | undefined;
  meta?: Record<string, unknown>;
  /** Override for tests. */
  logger?: Logger;
}

export interface RunOutcome<T> {
  runId: string;
  status: IngestStatus;
  rowsWritten: number;
  durationMs: number;
  result: T;
}

/**
 * Run `work` inside an `ingest_runs` row.
 *
 * On success the row lands `success`, or `partial` if the work called
 * `markPartial`. On a throw the row lands `failed` with a redacted message and
 * the error is rethrown — recording the failure is this function's job, deciding
 * whether it is fatal belongs to the caller. A multi-property job catches per
 * property so one failure cannot abort the rest (§7).
 */
export async function withIngestRun<T>(
  options: RunOptions,
  work: (run: RunHandle) => Promise<T>,
): Promise<RunOutcome<T>> {
  const startedAt = Date.now();

  const [row] = await db
    .insert(ingestRuns)
    .values({
      kind: options.kind,
      propertyId: options.propertyId ?? null,
      status: 'running',
      meta: options.meta ?? {},
    })
    .returning({ id: ingestRuns.id });

  if (!row) throw new Error('Failed to open an ingest_runs row');

  const base = options.logger ?? rootLogger;
  const log = base.child({
    job: options.kind,
    run_id: row.id,
    ...(options.propertyId === undefined ? {} : { property_id: options.propertyId }),
  });

  let rows = 0;
  let cost = 0;
  let meta: Record<string, unknown> = { ...(options.meta ?? {}) };
  const partialReasons: string[] = [];
  const failureReasons: string[] = [];

  const handle: RunHandle = {
    id: row.id,
    log,
    addRows: (count) => {
      rows += count;
    },
    addCost: (usd) => {
      cost += usd;
    },
    setMeta: (patch) => {
      meta = { ...meta, ...patch };
    },
    markPartial: (reason) => {
      partialReasons.push(reason);
    },
    markFailed: (reason) => {
      failureReasons.push(reason);
    },
    rowsWritten: () => rows,
  };

  log.info('run started');

  try {
    const result = await work(handle);
    const durationMs = Date.now() - startedAt;

    const status: IngestStatus =
      failureReasons.length > 0 ? 'failed' : partialReasons.length > 0 ? 'partial' : 'success';
    const reasons = [...failureReasons, ...partialReasons];

    await finish(row.id, {
      status,
      rows,
      cost,
      meta: reasons.length > 0 ? { ...meta, failure_reasons: reasons } : meta,
      error: reasons.length > 0 ? reasons.join('; ').slice(0, 2000) : null,
    });

    const level = status === 'failed' ? 'error' : status === 'partial' ? 'warn' : 'info';
    log[level]('run finished', {
      status,
      duration_ms: durationMs,
      rows_written: rows,
      ...(cost > 0 ? { cost_usd: cost } : {}),
      ...(reasons.length > 0 ? { failure_reasons: reasons } : {}),
    });

    return { runId: row.id, status, rowsWritten: rows, durationMs, result };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const message = redactError(error);

    await finish(row.id, { status: 'failed', rows, cost, meta, error: message }).catch(
      (writeError: unknown) => {
        // If we cannot even record the failure, say so — otherwise this looks
        // like a job that never ran.
        log.error('failed to record run failure', { error: redactError(writeError) });
      },
    );

    log.error('run failed', { status: 'failed', duration_ms: durationMs, rows_written: rows, error: message });

    throw error;
  }
}

async function finish(
  runId: string,
  fields: {
    status: IngestStatus;
    rows: number;
    cost: number;
    meta: Record<string, unknown>;
    error: string | null;
  },
) {
  await db
    .update(ingestRuns)
    .set({
      status: fields.status,
      finishedAt: sql`now()`,
      rowsWritten: fields.rows,
      costUsd: fields.cost.toFixed(6),
      meta: fields.meta,
      error: fields.error,
    })
    .where(eq(ingestRuns.id, runId));
}

/**
 * Reduce per-unit outcomes to a job status.
 *
 * §7: "Status `partial` when some properties succeed." The three-way split
 * matters on the /ops page — an all-failed run is an outage, a partial run is a
 * degraded one, and conflating them hides the difference.
 */
export function aggregateStatus(outcomes: {
  succeeded: number;
  failed: number;
}): IngestStatus {
  if (outcomes.failed === 0) return 'success';
  if (outcomes.succeeded === 0) return 'failed';
  return 'partial';
}
