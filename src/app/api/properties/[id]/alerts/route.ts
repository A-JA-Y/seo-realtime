import { z } from 'zod';

import { currentPrincipal } from '@/server/auth/config';
import { handleRoute, readJson } from '@/server/api/respond';
import { forProperty } from '@/server/db/scoped';
import { listAlerts } from '@/server/dashboard/queries';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const paramsSchema = z.object({ id: z.string().uuid() });
const bodySchema = z.object({ action: z.literal('read-all') });

/** GET — the in-app alert feed for one property. There is no other channel. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return handleRoute('GET /api/properties/:id/alerts', async () => {
    const { id } = paramsSchema.parse(await context.params);
    const scope = await forProperty(await currentPrincipal(), id);
    return { alerts: await listAlerts(scope) };
  });
}

/** POST — mark every open alert read. One statement, so it cannot half-apply. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleRoute('POST /api/properties/:id/alerts', async () => {
    const { id } = paramsSchema.parse(await context.params);
    bodySchema.parse(await readJson(request));

    // Holding a scope is proof the tenancy check passed, and the scope is what
    // applies the property predicate to the write.
    const scope = await forProperty(await currentPrincipal(), id);

    return { status: 'ok', marked: await scope.markAllAlertsRead() };
  });
}
