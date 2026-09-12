import { NextResponse, type NextRequest } from 'next/server';

/**
 * Route protection.
 *
 * Deliberately a coarse gate, not the authorisation model. It checks only that
 * a session cookie is PRESENT and bounces anonymous browsers to the login page
 * — it does not verify the signature, and it knows nothing about roles or
 * property grants.
 *
 * Middleware runs on the edge runtime, where the database is unreachable and
 * the bcrypt/Auth.js verification path does not run. Treating it as the
 * security boundary would mean the real checks happen somewhere that cannot
 * perform them. Every page and route therefore re-resolves the principal
 * server-side through `currentPrincipal()` and goes through
 * `assertPropertyAccess` / `forProperty`; this only saves an anonymous visitor
 * a pointless round trip.
 */

/** Auth.js names the cookie differently under HTTPS. */
const SESSION_COOKIES = [
  'authjs.session-token',
  '__Secure-authjs.session-token',
  'next-auth.session-token',
  '__Secure-next-auth.session-token',
];

export function middleware(request: NextRequest) {
  const hasSessionCookie = SESSION_COOKIES.some((name) => request.cookies.has(name));
  if (hasSessionCookie) return NextResponse.next();

  const url = new URL('/login', request.url);
  url.searchParams.set('next', request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.redirect(url);
}

export const config = {
  /*
   * PAGES only. `/api` is deliberately excluded in its entirety.
   *
   * Redirecting an API request to /login hands a JSON client a 307 and an HTML
   * page instead of the typed `{"error":{"code":"UNAUTHORIZED"}}` §10 asks for
   * — and a fetch that follows the redirect gets a 200 full of markup, which
   * looks like success. Every API route resolves the principal itself and
   * raises `UnauthorizedError`, so they are not unprotected; they simply answer
   * in the right language.
   *
   * Also excluded: the login page and static assets.
   */
  matcher: ['/((?!login|api|_next/static|_next/image|favicon.ico).*)'],
};
