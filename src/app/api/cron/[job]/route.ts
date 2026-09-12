import { NextResponse } from 'next/server';

import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { redactError } from '@/lib/redact';
import { requestSecretMatches } from '@/lib/secret-compare';
import { CRON_JOBS, JOBS } from '@/server/ops/cron-jobs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
/** Hobby caps at 60s. Jobs bound their own work well inside that. */
export const maxDuration = 60;

/**
 * The single authenticated cron dispatcher (§7).
 *
 * The jobs themselves live in `@/server/ops/cron-jobs` — a route file may only
 * export handlers and route config, and the dispatch table deserves tests that
 * do not need an HTTP request.
 */

async function dispatch(request: Request, jobName: string): Promise<Response> {
  /*
   * Constant-time, and it accepts either a Bearer header or `?secret=`.
   * Vercel's own cron sends the header automatically; a free external scheduler
   * often cannot set headers at all and needs the query string (§7).
   *
   * Without this check the endpoint is a public button that spends the
   * DataForSEO balance.
   */
  if (!requestSecretMatches(request, env.CRON_SECRET)) {
    logger.warn('rejected an unauthenticated cron request', { job: jobName });
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const job = JOBS[jobName];

  if (!job) {
    // 404 rather than 400: a typo'd job name in a scheduler config would
    // otherwise look like a job that ran and did nothing.
    return NextResponse.json(
      { status: 'error', code: 'UNKNOWN_JOB', job: jobName, known: CRON_JOBS },
      { status: 404 },
    );
  }

  const startedAt = Date.now();

  try {
    const outcome = await job();
    const durationMs = Date.now() - startedAt;

    logger.info('cron job finished', { job: jobName, status: outcome.status, duration_ms: durationMs });

    // A failed job returns 500 so the scheduler's own alerting sees it. That
    // is the opposite of the pingback route, where a non-200 would cause
    // DataForSEO to redeliver forever — a scheduler retrying a cron is fine.
    return NextResponse.json(
      { ...outcome, durationMs },
      { status: outcome.status === 'failed' ? 500 : 200 },
    );
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    logger.error('cron job threw', { job: jobName, duration_ms: durationMs, error: redactError(error) });

    return NextResponse.json(
      { job: jobName, status: 'failed', code: 'UNHANDLED', durationMs },
      { status: 500 },
    );
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ job: string }> },
): Promise<Response> {
  return dispatch(request, (await context.params).job);
}

/** §7: "Accept GET with ?secret= as well, so a free external scheduler works." */
export async function GET(
  request: Request,
  context: { params: Promise<{ job: string }> },
): Promise<Response> {
  return dispatch(request, (await context.params).job);
}
