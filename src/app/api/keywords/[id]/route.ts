import { z } from 'zod';

import { shiftDate, pacificToday } from '@/lib/gsc-dates';
import { assertKeywordAccess } from '@/server/auth/access';
import { currentPrincipal } from '@/server/auth/config';
import { handleRoute } from '@/server/api/respond';
import { forProperty } from '@/server/db/scoped';
import { getGscSeries } from '@/server/ingest/gsc-read';
import { keywords } from '@/server/db/schema';
import { eq } from 'drizzle-orm';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const paramsSchema = z.object({ id: z.string().uuid() });

/**
 * GET /api/keywords/:id — detail for one keyword.
 *
 * Addressed by keyword id, so tenancy cannot be checked until we know whose
 * keyword it is. `assertKeywordAccess` does the lookup and the check together;
 * looking the keyword up with an unscoped query first is precisely the leak.
 *
 * A keyword that does not exist and one belonging to another tenant both raise
 * 403. A 404 for the former would confirm which ids exist.
 */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  return handleRoute('GET /api/keywords/:id', async () => {
    const { id } = paramsSchema.parse(await context.params);

    const principal = await currentPrincipal();
    const { propertyId } = await assertKeywordAccess(principal, id);

    // Holding a scope is proof the check passed — it cannot be constructed
    // without it.
    const scope = await forProperty(principal, propertyId);

    const [keyword] = await scope.keywords(eq(keywords.id, id));
    if (!keyword) throw new Error('keyword vanished between the check and the read');

    const to = pacificToday();
    const from = shiftDate(to, -27);

    return {
      keyword: {
        id: keyword.id,
        propertyId: keyword.propertyId,
        term: keyword.term,
        isPrimary: keyword.isPrimary,
        isActive: keyword.isActive,
      },
      // Every number carries its source (§3 rule 1, acceptance criterion 7).
      searchConsole: {
        source: 'Search Console average position',
        from,
        to,
        points: await getGscSeries(id, from, to),
      },
    };
  });
}
