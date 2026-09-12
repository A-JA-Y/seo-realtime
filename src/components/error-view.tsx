'use client';

import { useEffect } from 'react';

import { FORBIDDEN_DIGEST } from '@/lib/error-digests';

/**
 * The one error view, mounted by every boundary.
 *
 * There are two boundaries and they are not interchangeable: **an error thrown
 * in a LAYOUT is caught by the PARENT segment's boundary, not its own.** The
 * tenancy check lives in the property layout, so a 403 lands in the ROOT
 * boundary — which is why the property-scoped boundary alone was never enough,
 * and why the "no access" wording was unreachable however carefully it was
 * written. Found by an end-to-end test; it is not obvious from the code.
 *
 * So both boundaries render this, and this knows the difference.
 */
export function ErrorView({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Next has already logged this server-side, redacted. This is the browser's
    // copy, and it is the digest only — a server error message can carry a
    // connection string or a provider response.
    console.error('page error', error.digest ?? '(no digest)');
  }, [error]);

  const forbidden = error.digest === FORBIDDEN_DIGEST;

  return (
    <main className="mx-auto flex min-h-dvh max-w-lg flex-col justify-center gap-4 px-6 py-16">
      <h1 className="text-xl font-semibold tracking-tight">
        {forbidden ? 'No access to this property' : 'Something went wrong'}
      </h1>

      <p className="text-muted-foreground text-sm leading-relaxed">
        {forbidden
          ? 'Your account is not granted this property. An agency admin can add it — nothing is wrong on your side, and the property has not been deleted.'
          : 'This page failed to load. Nothing was changed, and your data is intact — every write in this product is idempotent, so retrying is safe.'}
      </p>

      {/*
        The digest, never the message. It is the pointer into the server log,
        where the redacted detail already is (acceptance criterion 12). Suppressed
        for a 403, where it would be noise on a page that is not an error.
      */}
      {error.digest && !forbidden ? (
        <p className="text-muted-foreground text-xs">
          Reference <code className="font-mono">{error.digest}</code> — quote it if
          you report this; the detail is in the server log.
        </p>
      ) : null}

      <div className="flex gap-2">
        {forbidden ? null : (
          <button
            type="button"
            onClick={reset}
            className="bg-primary text-primary-foreground rounded-md px-3 py-1.5 text-sm font-medium"
          >
            Try again
          </button>
        )}
        {/*
          A plain anchor, deliberately. This boundary renders because something
          in the React tree threw; a client-side `<Link>` navigation keeps that
          tree and its broken router state alive, and a full document load is the
          one thing certain to clear it.
        */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a href="/" className="rounded-md border px-3 py-1.5 text-sm">
          All properties
        </a>
      </div>
    </main>
  );
}
