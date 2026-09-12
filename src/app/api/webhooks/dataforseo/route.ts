import { NextResponse } from 'next/server';

import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { redactError } from '@/lib/redact';
import { secretsMatch } from '@/lib/secret-compare';
import { handleSerpPingback } from '@/server/ingest/serp';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * DataForSEO pingback (§6).
 *
 * DataForSEO calls this when a queued SERP task completes, so nothing has to
 * poll `task_get` inside a serverless function — an explicit §16 anti-pattern,
 * and one that would be killed at Hobby's 60-second limit anyway.
 *
 * Two rules govern the responses here:
 *
 *  1. An unauthenticated caller gets 401 and nothing else. Without the secret
 *     check this endpoint is a public button that spends the account balance,
 *     because every hit triggers a billed `task_get`.
 *
 *  2. Every authenticated caller gets 200, INCLUDING on failure. DataForSEO
 *     retries a non-200 pingback indefinitely; a parse bug would become a
 *     permanent redelivery loop that also re-bills each `task_get`. Failures
 *     are recorded as a `failed` ingest_runs row, which is where /ops looks.
 */
export async function POST(request: Request): Promise<Response> {
  return handle(request);
}

/**
 * DataForSEO's pingback is documented as a GET with `$id` substituted into the
 * query string. Accepting both verbs costs nothing and avoids an entire class
 * of silent delivery failure.
 */
export async function GET(request: Request): Promise<Response> {
  return handle(request);
}

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url);

  // Constant-time. A plain === leaks the secret one character at a time
  // through response timing.
  if (!secretsMatch(url.searchParams.get('secret'), env.DATAFORSEO_PINGBACK_SECRET)) {
    logger.warn('rejected an unauthenticated DataForSEO pingback', {
      job: 'serp_pingback',
      // Never the provided value, and never the expected one.
      has_secret_param: url.searchParams.has('secret'),
    });
    return new NextResponse('Unauthorized', { status: 401 });
  }

  const taskId = url.searchParams.get('id');

  if (!taskId || taskId === '$id') {
    // '$id' unsubstituted means the pingback URL was stored wrong. That is a
    // configuration bug worth shouting about — every result is being lost.
    logger.error('DataForSEO pingback arrived without a usable task id', {
      job: 'serp_pingback',
      raw_id: taskId,
    });
    return NextResponse.json({ status: 'ignored', code: 'MISSING_TASK_ID' }, { status: 200 });
  }

  try {
    const outcome = await handleSerpPingback(taskId);
    return NextResponse.json(outcome, { status: 200 });
  } catch (error) {
    // Nothing should reach here — handleSerpPingback catches its own failures —
    // but a 500 from this route would start an infinite redelivery loop.
    logger.error('unhandled error in the DataForSEO pingback', {
      job: 'serp_pingback',
      error: redactError(error),
    });
    return NextResponse.json({ status: 'failed', code: 'UNHANDLED' }, { status: 200 });
  }
}
