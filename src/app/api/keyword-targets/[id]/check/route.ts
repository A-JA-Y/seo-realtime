import { z } from 'zod';

import { assertKeywordTargetAccess } from '@/server/auth/access';
import { currentPrincipal } from '@/server/auth/config';
import { ApiFailure, handleRoute } from '@/server/api/respond';
import { COST_PER_SERP } from '@/server/ingest/dataforseo-client';
import { LIVE_CHECK_COOLDOWN_MS, liveCheckTarget } from '@/server/ingest/serp';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const paramsSchema = z.object({ id: z.string().uuid() });

/**
 * POST /api/keyword-targets/:id/check — the dashboard's "check now".
 *
 * This endpoint spends money on every success: live mode is $0.0020 a call,
 * 3.3x the scheduled rate, and it is the only place in the product that uses
 * it. Two things guard it, and neither is optional.
 *
 * 1. Tenancy, via `assertKeywordTargetAccess` — a target id is a uuid someone
 *    could guess at, and paying to check a stranger's keyword is both a leak
 *    and a bill.
 * 2. The 5-minute cooldown, claimed atomically inside `liveCheckTarget` by a
 *    single conditional UPDATE. A read-then-act check here would let two
 *    simultaneous presses both pay.
 *
 * Deliberately NOT role-gated. The cooldown is the spend control and it is
 * per-target, so the ceiling is the same however many people press the button;
 * a client looking at their own dashboard is the intended user of "is it fixed
 * yet", and restricting that would be a rule the rate limit already enforces
 * more precisely.
 */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  return handleRoute('POST /api/keyword-targets/:id/check', async () => {
    const { id } = paramsSchema.parse(await context.params);

    const principal = await currentPrincipal();
    await assertKeywordTargetAccess(principal, id);

    const result = await liveCheckTarget(id);

    if (result.status === 'rate_limited') {
      const seconds = Math.ceil(result.retryAfterMs / 1000);
      throw new ApiFailure(
        'RATE_LIMITED',
        `Already checked within the last 5 minutes. Try again in ${seconds}s.`,
        429,
        { 'Retry-After': String(seconds) },
      );
    }

    if (result.status === 'failed') {
      // `liveCheckTarget` has already reduced the provider's answer to a status
      // line; it never carries credentials.
      throw new ApiFailure('PROVIDER_ERROR', result.reason, 502);
    }

    return {
      status: 'ok',
      source: 'Live rank check — DataForSEO live mode',
      costUsd: result.costUsd ?? COST_PER_SERP.live,
      cooldownSeconds: LIVE_CHECK_COOLDOWN_MS / 1000,
      check: {
        found: result.parsed.found,
        rankGroup: result.parsed.rankGroup,
        rankAbsolute: result.parsed.rankAbsolute,
        rankingUrl: result.parsed.rankingUrl,
        serpFeatures: result.parsed.serpFeatures,
      },
    };
  });
}
