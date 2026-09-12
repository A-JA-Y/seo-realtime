export default function Home() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center gap-4 px-6 py-16">
      <h1 className="text-2xl font-semibold tracking-tight">Rank Tracker</h1>
      <p className="text-muted-foreground text-sm leading-relaxed">
        Foundation is in place. Ingestion, auth and the dashboard land in later milestones.
      </p>
      <a
        href="/api/health"
        className="text-source-serp w-fit text-sm underline underline-offset-4"
      >
        /api/health
      </a>
    </main>
  );
}
