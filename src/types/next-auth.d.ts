import type { UserRole } from '@/server/db/schema';

/**
 * Session and token shape.
 *
 * The session carries identity only — user id, organisation, role. The list of
 * properties a client may read is deliberately NOT here: see
 * `src/server/auth/access.ts` for why revocation must not wait for a new login.
 */
declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      email: string;
      name?: string | null;
      orgId: string;
      role: UserRole;
    };
  }

  interface User {
    id?: string;
    email?: string | null;
    name?: string | null;
    orgId: string;
    role: UserRole;
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    userId: string;
    orgId: string;
    role: UserRole;
    email: string;
  }
}

export {};
