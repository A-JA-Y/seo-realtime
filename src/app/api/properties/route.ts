import { currentPrincipal } from '@/server/auth/config';
import { UnauthorizedError } from '@/server/auth/access';
import { accessibleProperties } from '@/server/db/scoped';
import { handleRoute } from '@/server/api/respond';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * GET /api/properties — the properties this session may read.
 *
 * The listing goes through the same access rule as the single-property check.
 * A listing that filtered differently from `assertPropertyAccess` is exactly
 * how cross-tenant leaks happen, so there is only one implementation.
 */
export async function GET() {
  return handleRoute('GET /api/properties', async () => {
    const principal = await currentPrincipal();
    if (!principal) throw new UnauthorizedError();

    const rows = await accessibleProperties(principal);

    return {
      properties: rows.map((p) => ({
        id: p.id,
        name: p.name,
        domain: p.domain,
        gscSiteUrl: p.gscSiteUrl,
        timezone: p.timezone,
        isActive: p.isActive,
        backfilledAt: p.backfilledAt,
      })),
    };
  });
}
