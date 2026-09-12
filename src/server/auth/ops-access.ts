import { assertRole, type Principal } from './access';
import { currentPrincipal } from './config';

/**
 * Access gate for `/ops` (§10: agency_admin only).
 *
 * `/ops` shows ingest errors, per-property freshness and month-to-date spend
 * across the whole organisation, so it is the one page an agency_member should
 * not see either.
 */
export interface OpsAccess {
  allowed: boolean;
  reason: string;
  principal: Principal | null;
}

export async function checkOpsAccess(): Promise<OpsAccess> {
  const principal = await currentPrincipal();

  if (!principal) {
    return { allowed: false, reason: 'Sign in to view operations.', principal: null };
  }

  try {
    assertRole(principal, 'agency_admin');
    return { allowed: true, reason: 'agency_admin', principal };
  } catch {
    return {
      allowed: false,
      reason: 'Operations is restricted to agency administrators.',
      principal,
    };
  }
}
