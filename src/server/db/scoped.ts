import { and, eq, type SQL } from 'drizzle-orm';

import { assertPropertyAccess, type Principal } from '@/server/auth/access';
import { db } from '@/server/db';
import {
  alerts,
  dailyRankRollups,
  gscSnapshots,
  keywordTargets,
  keywords,
  properties,
  serpChecks,
} from '@/server/db/schema';

/**
 * Property-scoped query builder (§10).
 *
 * "Route every query through a `forProperty(propertyId)` builder so writing an
 * unscoped query is structurally difficult rather than merely discouraged."
 *
 * The structural part is the constructor: `forProperty` is async and performs
 * the access check before it returns. There is no way to obtain a scope for a
 * property you cannot read, so a route holding a `PropertyScope` has already
 * passed tenancy — the check cannot be forgotten because it is what produced
 * the object.
 *
 * Every builder here pre-applies `property_id = <scope>`, and callers add their
 * own predicates on top with `.where()`, which ANDs rather than replaces —
 * verified by test, because a `.where()` that replaced the scope would silently
 * undo all of this.
 */

/**
 * A scope is whatever `forProperty` returns.
 *
 * Inferred rather than hand-declared: writing the query-builder return types by
 * hand means restating drizzle's generics, and a mistake there is silently
 * papered over by a cast at the call site.
 */
export type PropertyScope = Awaited<ReturnType<typeof forProperty>>;

/**
 * Build a scope, or throw.
 *
 * Throws `UnauthorizedError` (401) with no principal and `ForbiddenError` (403)
 * when the principal may not read the property — including when the property
 * does not exist, so the two are indistinguishable to a caller probing ids.
 */
export async function forProperty(principal: Principal | null | undefined, propertyId: string) {
  await assertPropertyAccess(principal, propertyId);

  // assertPropertyAccess throws on a null principal, so this is safe.
  const owner = principal as Principal;
  const scope = <T>(column: T, extra?: SQL) =>
    extra ? and(eq(column as never, propertyId), extra) : eq(column as never, propertyId);

  return {
    propertyId,
    principal: owner,

    async property() {
      const [row] = await db.select().from(properties).where(eq(properties.id, propertyId));
      return row;
    },

    keywords: (extra?: SQL) => db.select().from(keywords).where(scope(keywords.propertyId, extra)),

    keywordTargets: (extra?: SQL) =>
      db.select().from(keywordTargets).where(scope(keywordTargets.propertyId, extra)),

    gscSnapshots: (extra?: SQL) =>
      db.select().from(gscSnapshots).where(scope(gscSnapshots.propertyId, extra)),

    serpChecks: (extra?: SQL) => db.select().from(serpChecks).where(scope(serpChecks.propertyId, extra)),

    alerts: (extra?: SQL) => db.select().from(alerts).where(scope(alerts.propertyId, extra)),

    dailyRankRollups: (extra?: SQL) =>
      db
        .select()
        .from(dailyRankRollups)
        .innerJoin(keywordTargets, eq(keywordTargets.id, dailyRankRollups.keywordTargetId))
        .where(scope(keywordTargets.propertyId, extra)),
  };
}

/**
 * Every property the principal may read, as rows.
 *
 * The listing counterpart to `forProperty`. A route that built its own "all
 * properties" query would be reimplementing the access rule — and a listing
 * that filtered differently from the single-property check is exactly how
 * cross-tenant leaks happen.
 */
export async function accessibleProperties(principal: Principal) {
  const { accessiblePropertyIds } = await import('@/server/auth/access');
  const ids = await accessiblePropertyIds(principal);

  if (ids.length === 0) return [];

  const { inArray } = await import('drizzle-orm');
  return db
    .select()
    .from(properties)
    .where(inArray(properties.id, ids))
    .orderBy(properties.name);
}
