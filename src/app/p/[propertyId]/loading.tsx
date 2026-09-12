/**
 * Skeleton, not a spinner.
 *
 * These pages fan out several queries against a cold serverless database, so
 * the wait is real. A skeleton that matches the layout keeps the page from
 * jumping when the data lands.
 *
 * A `<div>`, NOT a `<main>`. During the streaming handoff Next has both this
 * and the page in the document at once, and two `<main>` landmarks is a
 * document with no main content as far as a screen reader is concerned. Caught
 * by an end-to-end test that could not decide which `<main>` it meant.
 */
export default function Loading() {
  return (
    <div
      className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6"
      role="status"
      aria-busy="true"
    >
      <span className="sr-only">Loading</span>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="bg-card space-y-3 rounded-xl border p-5">
            <div className="bg-muted h-3 w-24 animate-pulse rounded" />
            <div className="bg-muted h-7 w-16 animate-pulse rounded" />
            <div className="bg-muted h-3 w-32 animate-pulse rounded" />
          </div>
        ))}
      </div>
      <div className="bg-card space-y-3 rounded-xl border p-5">
        <div className="bg-muted h-3 w-32 animate-pulse rounded" />
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="bg-muted h-8 w-full animate-pulse rounded" />
        ))}
      </div>
    </div>
  );
}
