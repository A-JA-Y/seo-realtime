/**
 * Stable error digests a client error boundary can match on.
 *
 * Lives in `lib/`, not next to the error classes that use it, because
 * `error.tsx` is a CLIENT component: importing this from `server/auth/access`
 * pulled that module — and through it `pg` — into the browser bundle and broke
 * the build outright. A shared constant between server and client has to have
 * no server dependencies at all.
 *
 * Why a digest and not the message: in production Next replaces a server
 * error's message with a generic string before it reaches the boundary, so that
 * a stack trace or a connection string cannot leak. Only `digest` survives, and
 * Next honours one the error already carries.
 *
 * These are not secrets. "This was a 403" is something the visitor already
 * knows; the point is that the boundary can tell.
 */
export const FORBIDDEN_DIGEST = 'RANKTRACKER_FORBIDDEN';
