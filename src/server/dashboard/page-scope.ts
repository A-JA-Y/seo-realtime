import { redirect } from 'next/navigation';

import { currentPrincipal } from '@/server/auth/config';
import { ForbiddenError, UnauthorizedError } from '@/server/auth/access';
import { forProperty, type PropertyScope } from '@/server/db/scoped';

export interface PageScope {
  scope: PropertyScope;
  property: NonNullable<Awaited<ReturnType<PropertyScope['property']>>>;
}

/**
 * Resolve a property scope for a page, or leave.
 *
 * Pages get a redirect to /login when there is no session and a 403 page when
 * there is one that may not read this property. Never a 404: pretending the
 * property does not exist would be a different lie to a user who can see the
 * id in their own URL bar, and §10 is explicit that the API answers 403 here.
 */
export async function pageScope(propertyId: string): Promise<PageScope> {
  const principal = await currentPrincipal();

  try {
    const scope = await forProperty(principal, propertyId);
    const property = await scope.property();
    if (!property) throw new ForbiddenError('No access to this property');
    return { scope, property };
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      redirect(`/login?next=${encodeURIComponent(`/p/${propertyId}`)}`);
    }
    throw error;
  }
}
