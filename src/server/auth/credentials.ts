import bcrypt from 'bcryptjs';
import { eq } from 'drizzle-orm';

import { logger } from '@/lib/logger';
import { redactError } from '@/lib/redact';
import { db } from '@/server/db';
import { users } from '@/server/db/schema';
import type { Principal } from './access';

/**
 * Password verification, separate from the Auth.js wiring.
 *
 * Kept out of `config.ts` because that module imports `next-auth`, which pulls
 * in Next's server runtime — so anything importing it cannot be unit-tested
 * outside a Next process. This is the part worth testing: the hashing cost, the
 * normalisation, and the timing behaviour on an unknown address.
 */

/** §2: bcrypt cost 12. */
export const BCRYPT_COST = 12;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST);
}

/**
 * A bcrypt hash of a value no one knows, used to keep the timing of a login
 * attempt for an unknown email indistinguishable from a known one.
 *
 * Without it, "no such user" returns in microseconds while a real user costs a
 * full cost-12 verification — a reliable oracle for enumerating which email
 * addresses have accounts. Generated at module load so it is a genuine hash at
 * the same cost, rather than a literal that could drift from BCRYPT_COST.
 */
const timingDecoy = bcrypt.hashSync(
  'not-a-real-password-this-only-burns-the-same-cpu',
  BCRYPT_COST,
);

/**
 * Verify credentials and return the principal, or null.
 *
 * Never distinguishes "no such account" from "wrong password" — not in the
 * return value, not in the log, and not in how long it takes.
 */
export async function verifyCredentials(
  email: string,
  password: string,
): Promise<Principal | null> {
  const normalised = email.trim().toLowerCase();

  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      passwordHash: users.passwordHash,
      orgId: users.orgId,
      role: users.role,
    })
    .from(users)
    .where(eq(users.email, normalised))
    .limit(1);

  // Always run a comparison, even for an unknown address.
  const ok = await bcrypt.compare(password, user?.passwordHash ?? timingDecoy);

  if (!user || !ok) return null;

  // Best-effort: failing to record the login must not fail the login.
  void db
    .update(users)
    .set({ lastLoginAt: new Date() })
    .where(eq(users.id, user.id))
    .catch((error: unknown) => {
      logger.warn('could not record last_login_at', { error: redactError(error) });
    });

  return { userId: user.id, orgId: user.orgId, role: user.role, email: user.email };
}
