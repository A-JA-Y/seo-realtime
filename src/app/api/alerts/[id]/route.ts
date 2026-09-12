import { z } from 'zod';

import { assertAlertAccess } from '@/server/auth/access';
import { currentPrincipal } from '@/server/auth/config';
import { ApiFailure, handleRoute, readJson } from '@/server/api/respond';
import { forProperty } from '@/server/db/scoped';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const paramsSchema = z.object({ id: z.string().uuid() });
const bodySchema = z.object({ action: z.enum(['read', 'unread', 'resolve']) });

/**
 * PATCH /api/alerts/:id — mark an alert read, unread, or resolved.
 *
 * Tenancy first: `assertAlertAccess` resolves the owning property and checks
 * it in one step, so the alert is never read by an unscoped query. The write
 * then goes through the scope, which re-applies the property predicate — a
 * route cannot forget it, because the scope is what performs it.
 *
 * Resolving by hand is deliberately allowed alongside the engine's automatic
 * resolution. A person can decide a condition is handled before the data
 * catches up — and because the partial unique index keys on
 * `signature WHERE resolved_at IS NULL`, resolving frees the signature, so a
 * genuine recurrence raises a fresh alert instead of being suppressed for ever
 * behind a stale one.
 */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleRoute('PATCH /api/alerts/:id', async () => {
    const { id } = paramsSchema.parse(await context.params);
    const { action } = bodySchema.parse(await readJson(request));

    const principal = await currentPrincipal();
    const { propertyId } = await assertAlertAccess(principal, id);
    const scope = await forProperty(principal, propertyId);

    const alert =
      action === 'resolve'
        ? await scope.resolveAlert(id)
        : await scope.markAlertRead(id, action === 'read');

    if (!alert) throw new ApiFailure('FORBIDDEN', 'No access to this alert.', 403);

    return { status: 'ok', alert };
  });
}
