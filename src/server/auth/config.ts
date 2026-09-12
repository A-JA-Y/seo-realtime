import NextAuth from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { z } from 'zod';

import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { userRole } from '@/server/db/schema';
import type { Principal } from './access';
import { verifyCredentials } from './credentials';

/**
 * The claims we put in the JWT, validated on the way back out.
 *
 * The token is signed by us, so this is not about forgery — it is about
 * SHAPE. A token issued before a schema change (a role renamed, a claim added)
 * is cryptographically valid and semantically stale, and reading a missing
 * claim as `undefined` would hand `role: undefined` to the access checks.
 * Failing to parse instead logs the holder out, which is the safe outcome.
 */
const tokenClaimsSchema = z.object({
  userId: z.string().min(1),
  orgId: z.string().min(1),
  role: z.enum(userRole.enumValues),
  email: z.string().min(1),
});

/**
 * Auth.js v5 with a Credentials provider (§10).
 *
 * Accounts are provisioned manually per client, which suits an agency with a
 * handful of retainer clients and needs no email-sending service at all.
 */

const credentialsSchema = z.object({
  email: z.string().min(3).max(320),
  password: z.string().min(1).max(1024),
});

export const { handlers, auth, signIn, signOut } = NextAuth({
  secret: env.AUTH_SECRET,
  // JWT sessions: the Credentials provider cannot use a database session, and
  // nothing here needs one.
  session: { strategy: 'jwt', maxAge: 60 * 60 * 12 },
  pages: { signIn: '/login' },
  trustHost: true,

  providers: [
    Credentials({
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },

      async authorize(raw) {
        const parsed = credentialsSchema.safeParse(raw);
        if (!parsed.success) return null;

        const principal = await verifyCredentials(parsed.data.email, parsed.data.password);

        if (!principal) {
          // Log the attempt, never the password, and never whether the address
          // exists — that distinction is the enumeration oracle.
          logger.warn('failed sign-in attempt', { job: 'auth' });
          return null;
        }

        return {
          id: principal.userId,
          email: principal.email,
          orgId: principal.orgId,
          role: principal.role,
        };
      },
    }),
  ],

  callbacks: {
    jwt({ token, user }) {
      // `user` is present only on the sign-in pass.
      if (user) {
        return {
          ...token,
          userId: user.id ?? '',
          orgId: user.orgId,
          role: user.role,
          email: user.email ?? '',
        };
      }
      return token;
    },

    session({ session, token }) {
      const claims = tokenClaimsSchema.safeParse(token);

      if (!claims.success) {
        /*
         * A token we cannot read is a token we must not trust. Blanking the
         * identifying claims makes `currentPrincipal` return null, which every
         * route already treats as unauthenticated — so the holder is logged
         * out rather than handed a session with `role: undefined`.
         */
        logger.warn('discarding a session token with unreadable claims', { job: 'auth' });
        return {
          ...session,
          user: { id: '', email: '', orgId: '', role: 'client' as const, name: null },
        };
      }

      return {
        ...session,
        user: {
          id: claims.data.userId,
          email: claims.data.email,
          orgId: claims.data.orgId,
          role: claims.data.role,
          name: session.user?.name ?? null,
        },
      };
    },
  },
});

/**
 * The principal for the current request, or null.
 *
 * Every route and page resolves identity through this one function, so there is
 * a single place where "who is asking" is decided.
 */
export async function currentPrincipal(): Promise<Principal | null> {
  const session = await auth();
  if (!session?.user?.id || !session.user.orgId) return null;

  return {
    userId: session.user.id,
    orgId: session.user.orgId,
    role: session.user.role,
    email: session.user.email,
  };
}
