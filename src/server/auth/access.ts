import { and, eq, inArray } from 'drizzle-orm';

import { db } from '@/server/db';
import { properties, userProperties, type UserRole } from '@/server/db/schema';

/**
 * Tenancy enforcement (§10).
 *
 * "All routes are server-side, session-authenticated, and scoped through a
 * single `assertPropertyAccess(session, propertyId)` helper."
 *
 * Acceptance criterion 6: "A client user cannot read another property's data
 * through any route — proven by test."
 */

/** The identity every access decision is made against. */
export interface Principal {
  userId: string;
  orgId: string;
  role: UserRole;
  email: string;
}

export class UnauthorizedError extends Error {
  readonly status = 401;
  readonly code = 'UNAUTHORIZED';

  constructor(message = 'Authentication required') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export class ForbiddenError extends Error {
  readonly status = 403;
  readonly code = 'FORBIDDEN';

  constructor(message = 'You do not have access to this property') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/** Agency roles see every property in their organisation. */
export function isAgencyRole(role: UserRole): boolean {
  return role === 'agency_admin' || role === 'agency_member';
}

/**
 * Can this principal read this property?
 *
 * Two rules, and the order matters:
 *
 *  1. The property must belong to the principal's ORGANISATION. This is checked
 *     first and applies to every role including `agency_admin` — an admin is an
 *     admin of their own agency, not of the database.
 *
 *  2. A `client` additionally needs an explicit grant in `user_properties`. A
 *     client with no grants sees nothing, deliberately: fail-closed means a
 *     half-provisioned account leaks no data.
 *
 * Resolved from the database on every call rather than from the session token.
 * §10 suggests putting the permitted property list in the token; that makes
 * revocation take effect only at next login, so a client removed from an
 * account keeps reading it until their session expires. One indexed query is
 * worth not having that window.
 */
export async function canAccessProperty(
  principal: Principal,
  propertyId: string,
): Promise<boolean> {
  const [property] = await db
    .select({ orgId: properties.orgId })
    .from(properties)
    .where(eq(properties.id, propertyId))
    .limit(1);

  // A property that does not exist and a property in another organisation are
  // deliberately indistinguishable from here: both are simply "no".
  if (!property || property.orgId !== principal.orgId) return false;

  if (isAgencyRole(principal.role)) return true;

  const [grant] = await db
    .select({ userId: userProperties.userId })
    .from(userProperties)
    .where(
      and(
        eq(userProperties.userId, principal.userId),
        eq(userProperties.propertyId, propertyId),
      ),
    )
    .limit(1);

  return Boolean(grant);
}

/**
 * Throw unless the principal may read this property.
 *
 * The single choke point §10 asks for. Every route that touches property-scoped
 * data goes through this or through `forProperty`, which calls it.
 */
export async function assertPropertyAccess(
  principal: Principal | null | undefined,
  propertyId: string,
): Promise<void> {
  if (!principal) throw new UnauthorizedError();
  if (!(await canAccessProperty(principal, propertyId))) throw new ForbiddenError();
}

/**
 * Every property this principal may read.
 *
 * The list form of the same rule, so a route never has to reimplement it — an
 * "all properties" listing that filtered differently from the single-property
 * check is exactly how cross-tenant leaks happen.
 */
export async function accessiblePropertyIds(principal: Principal): Promise<string[]> {
  if (isAgencyRole(principal.role)) {
    const rows = await db
      .select({ id: properties.id })
      .from(properties)
      .where(eq(properties.orgId, principal.orgId));
    return rows.map((r) => r.id);
  }

  const rows = await db
    .select({ id: properties.id })
    .from(properties)
    .innerJoin(userProperties, eq(userProperties.propertyId, properties.id))
    .where(
      and(eq(userProperties.userId, principal.userId), eq(properties.orgId, principal.orgId)),
    );

  return rows.map((r) => r.id);
}

/** Filter a caller-supplied list down to what the principal may actually read. */
export async function filterAccessibleProperties(
  principal: Principal,
  propertyIds: readonly string[],
): Promise<string[]> {
  if (propertyIds.length === 0) return [];

  const allowed = new Set(await accessiblePropertyIds(principal));
  return propertyIds.filter((id) => allowed.has(id));
}

/**
 * Throw unless the principal holds one of these roles.
 *
 * `/ops` is agency_admin only (§10), and so is creating a property.
 */
export function assertRole(
  principal: Principal | null | undefined,
  ...roles: UserRole[]
): void {
  if (!principal) throw new UnauthorizedError();
  if (!roles.includes(principal.role)) {
    throw new ForbiddenError(`This action requires: ${roles.join(' or ')}`);
  }
}

/**
 * Resolve the property that owns a keyword, then check access to it.
 *
 * Routes addressed by keyword id (`/api/keywords/:id`) cannot check tenancy
 * until they know whose keyword it is — and looking the keyword up with an
 * unscoped query first is precisely the leak. This does the lookup and the
 * check together, and reveals nothing about a keyword the caller may not read.
 */
export async function assertKeywordAccess(
  principal: Principal | null | undefined,
  keywordId: string,
): Promise<{ propertyId: string }> {
  if (!principal) throw new UnauthorizedError();

  const { keywords } = await import('@/server/db/schema');

  const [keyword] = await db
    .select({ propertyId: keywords.propertyId })
    .from(keywords)
    .where(eq(keywords.id, keywordId))
    .limit(1);

  // A keyword that does not exist and one in another tenant both raise 403,
  // never 404. A 404 here would confirm which ids exist — an enumeration
  // oracle across tenants.
  if (!keyword) throw new ForbiddenError();

  await assertPropertyAccess(principal, keyword.propertyId);
  return { propertyId: keyword.propertyId };
}

/** Same, for a keyword target. */
export async function assertKeywordTargetAccess(
  principal: Principal | null | undefined,
  keywordTargetId: string,
): Promise<{ propertyId: string; keywordId: string }> {
  if (!principal) throw new UnauthorizedError();

  const { keywordTargets } = await import('@/server/db/schema');

  const [target] = await db
    .select({ propertyId: keywordTargets.propertyId, keywordId: keywordTargets.keywordId })
    .from(keywordTargets)
    .where(eq(keywordTargets.id, keywordTargetId))
    .limit(1);

  if (!target) throw new ForbiddenError();

  await assertPropertyAccess(principal, target.propertyId);
  return target;
}

/**
 * Resolve the property that owns an alert, then check access to it.
 *
 * Same shape as `assertKeywordTargetAccess`, and for the same reason: an alert
 * is addressed by its own id, so tenancy cannot be checked until we know whose
 * alert it is — and looking it up with an unscoped query first is precisely the
 * leak. A missing alert and another tenant's alert both raise 403, so the
 * endpoint is not an enumeration oracle.
 */
export async function assertAlertAccess(
  principal: Principal | null | undefined,
  alertId: string,
): Promise<{ propertyId: string }> {
  if (!principal) throw new UnauthorizedError();

  const { alerts } = await import('@/server/db/schema');

  const [alert] = await db
    .select({ propertyId: alerts.propertyId })
    .from(alerts)
    .where(eq(alerts.id, alertId))
    .limit(1);

  if (!alert) throw new ForbiddenError();

  await assertPropertyAccess(principal, alert.propertyId);
  return alert;
}

/** Narrow a set of property ids to those in the principal's org. Used by `forProperty`. */
export async function assertPropertiesInOrg(
  principal: Principal,
  propertyIds: readonly string[],
): Promise<void> {
  if (propertyIds.length === 0) return;

  const rows = await db
    .select({ id: properties.id })
    .from(properties)
    .where(and(inArray(properties.id, [...propertyIds]), eq(properties.orgId, principal.orgId)));

  if (rows.length !== new Set(propertyIds).size) throw new ForbiddenError();
}
