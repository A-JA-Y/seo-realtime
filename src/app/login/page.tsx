import { redirect } from 'next/navigation';
import { AuthError } from 'next-auth';

import { currentPrincipal, signIn } from '@/server/auth/config';

export const dynamic = 'force-dynamic';

/**
 * Sign-in (§10).
 *
 * A server action rather than a client form: the password never enters a
 * client bundle, and there is no fetch for a browser extension to observe.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  if (await currentPrincipal()) redirect('/');

  const params = await searchParams;

  async function authenticate(formData: FormData) {
    'use server';

    const next = String(formData.get('next') ?? '/') || '/';
    // Only same-origin paths: an attacker-supplied absolute URL here would turn
    // the login form into an open redirect.
    const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/';

    try {
      await signIn('credentials', {
        email: String(formData.get('email') ?? ''),
        password: String(formData.get('password') ?? ''),
        redirectTo: safeNext,
      });
    } catch (error) {
      // next/navigation signals a redirect by throwing; let that through.
      if (error instanceof AuthError) {
        redirect(`/login?error=1&next=${encodeURIComponent(safeNext)}`);
      }
      throw error;
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6 py-16">
      <h1 className="text-xl font-semibold tracking-tight">Rank Tracker</h1>
      <p className="text-muted-foreground mt-1 mb-6 text-sm">Sign in to your account.</p>

      <form action={authenticate} className="flex flex-col gap-3">
        <input type="hidden" name="next" value={params.next ?? '/'} />

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Email</span>
          <input
            name="email"
            type="email"
            autoComplete="username"
            required
            className="border-input bg-background focus-visible:ring-ring rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
          />
        </label>

        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Password</span>
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className="border-input bg-background focus-visible:ring-ring rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
          />
        </label>

        {params.error && (
          /*
           * One message for every failure. Distinguishing "no such account"
           * from "wrong password" tells an attacker which addresses are worth
           * attacking — the same reason the server runs a bcrypt comparison
           * even when the email is unknown.
           */
          <p className="text-destructive text-sm" role="alert">
            Those credentials were not recognised.
          </p>
        )}

        <button
          type="submit"
          className="bg-primary text-primary-foreground mt-2 rounded-md px-3 py-2 text-sm font-medium"
        >
          Sign in
        </button>
      </form>

      <p className="text-muted-foreground mt-6 text-xs leading-relaxed">
        Accounts are provisioned by your agency. There is no self-service sign-up
        and no password reset email — ask your account manager.
      </p>
    </main>
  );
}
