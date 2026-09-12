import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';

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

    /*
     * Alert mutations live on the scope for the same reason the reads do: the
     * property predicate is applied HERE, not by each caller remembering to.
     * A route holding a scope has already passed tenancy, so these cannot
     * touch another tenant's rows even if the alert id came from a URL.
     */
    async markAlertRead(alertId: string, read: boolean) {
      const [row] = await db
        .update(alerts)
        .set({ readAt: read ? sql`now()` : null })
        .where(and(eq(alerts.id, alertId), eq(alerts.propertyId, propertyId)))
        .returning({ id: alerts.id, readAt: alerts.readAt, resolvedAt: alerts.resolvedAt });
      return row;
    },

    /**
     * Resolve an alert, and mark it read on the way.
     *
     * Resolving is not cosmetic: the partial unique index keys on
     * `signature WHERE resolved_at IS NULL`, so an open alert holds its
     * signature and suppresses a recurrence. Closing one frees it.
     */
    async resolveAlert(alertId: string) {
      const [row] = await db
        .update(alerts)
        .set({ resolvedAt: sql`now()`, readAt: sql`coalesce(${alerts.readAt}, now())` })
        .where(and(eq(alerts.id, alertId), eq(alerts.propertyId, propertyId)))
        .returning({ id: alerts.id, readAt: alerts.readAt, resolvedAt: alerts.resolvedAt });
      return row;
    },

    /** One statement, so it cannot half-apply. */
    async markAllAlertsRead() {
      const rows = await db
        .update(alerts)
        .set({ readAt: sql`now()` })
        .where(and(eq(alerts.propertyId, propertyId), isNull(alerts.readAt)))
        .returning({ id: alerts.id });
      return rows.length;
    },

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
