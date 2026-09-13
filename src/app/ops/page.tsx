import { checkOpsAccess } from '@/server/auth/ops-access';
import {
  GSC_STALE_HOURS,
  ingestHealth,
  monthToDateSpend,
  recentIngestRuns,
  type IngestRunRow,
} from '@/server/ops/queries';

export const dynamic = 'force-dynamic';

const usd = (n: number) => `$${n.toFixed(4)}`;
const usd2 = (n: number) => `$${n.toFixed(2)}`;

function duration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function relative(date: Date | null): string {
  if (!date) return 'never';
  const hours = (Date.now() - date.getTime()) / 3_600_000;
  if (hours < 1) return `${Math.round(hours * 60)}m ago`;
  if (hours < 48) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const STATUS_STYLE: Record<IngestRunRow['status'], string> = {
  success: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  partial: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  failed: 'bg-red-500/10 text-red-700 dark:text-red-400',
  running: 'bg-sky-500/10 text-sky-700 dark:text-sky-400',
};

export default async function OpsPage() {
  const access = await checkOpsAccess();

  if (!access.allowed) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-xl font-semibold tracking-tight">Operations</h1>
        <p className="text-muted-foreground mt-3 text-sm leading-relaxed">{access.reason}</p>
      </main>
    );
  }

  const [runs, spend, health] = await Promise.all([
    recentIngestRuns(),
    monthToDateSpend(),
    ingestHealth(),
  ]);

  const stale = health.filter((h) => h.gscStale);
  const failures = runs.filter((r) => r.status === 'failed' || r.status === 'partial');

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-xl font-semibold tracking-tight">Operations</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Ingest health and spend. Every figure here is labelled with where it came from.
        </p>
      </header>

      {/* ── Spend ────────────────────────────────────────────────────────── */}
      <section className="mb-8 grid gap-4 sm:grid-cols-3">
        <div className="border-border rounded-lg border p-4">
          <div className="text-muted-foreground text-xs uppercase tracking-wide">
            DataForSEO, month to date
          </div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">
            {usd2(spend.monthToDateUsd)}
          </div>
          <div className="text-muted-foreground mt-1 text-xs">
            {/* Acceptance criterion 9: this IS sum(serp_checks.cost_usd). */}
            sum of {spend.checksThisMonth} charged SERP checks
          </div>
        </div>

        <div className="border-border rounded-lg border p-4">
          <div className="text-muted-foreground text-xs uppercase tracking-wide">
            Projected this month
          </div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">
            {usd2(spend.projectedMonthUsd)}
          </div>
          <div className="text-muted-foreground mt-1 text-xs">month-to-date, scaled</div>
        </div>

        <div className="border-border rounded-lg border p-4">
          <div className="text-muted-foreground text-xs uppercase tracking-wide">
            Estimated at submission
          </div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">
            {usd2(spend.estimatedFromRunsUsd)}
          </div>
          <div className="text-muted-foreground mt-1 text-xs">
            {/* A gap means tasks were submitted and never came back. */}
            from ingest_runs — a gap means results went missing
          </div>
        </div>
      </section>

      {/* ── Freshness ────────────────────────────────────────────────────── */}
      <section className="mb-8">
        <h2 className="mb-3 text-sm font-semibold">Ingest freshness</h2>

        {stale.length > 0 && (
          <div className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
            <strong className="font-medium">
              {stale.length} propert{stale.length === 1 ? 'y has' : 'ies have'} received no Search
              Console rows in {GSC_STALE_HOURS} hours.
            </strong>{' '}
            <span className="text-muted-foreground">
              Silent ingest death is the most likely serious failure here — a job that stops
              running produces no error, only an absence.
            </span>
          </div>
        )}

        <div className="border-border overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground text-xs uppercase">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Property</th>
                <th className="px-3 py-2 text-left font-medium">Last Search Console row</th>
                <th className="px-3 py-2 text-left font-medium">Last SERP check</th>
              </tr>
            </thead>
            <tbody>
              {health.length === 0 && (
                <tr>
                  <td className="text-muted-foreground px-3 py-4" colSpan={3}>
                    No active properties.
                  </td>
                </tr>
              )}
              {health.map((row) => (
                <tr key={row.propertyId} className="border-border border-t">
                  <td className="px-3 py-2">{row.propertyName}</td>
                  <td className={`px-3 py-2 ${row.gscStale ? 'text-amber-600 dark:text-amber-400' : ''}`}>
                    {relative(row.lastGscRowAt)}
                  </td>
                  <td className="px-3 py-2">{relative(row.lastSerpCheckAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Runs ─────────────────────────────────────────────────────────── */}
      <section>
        <h2 className="mb-3 text-sm font-semibold">
          Last {runs.length} ingest runs, most recent per job
          {failures.length > 0 && (
            <span className="text-muted-foreground ml-2 font-normal">
              — {failures.length} not fully successful
            </span>
          )}
        </h2>

        <div className="border-border overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground text-xs uppercase">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Job</th>
                <th className="px-3 py-2 text-left font-medium">Property</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
                <th className="px-3 py-2 text-right font-medium">Duration</th>
                <th className="px-3 py-2 text-right font-medium">Rows</th>
                <th className="px-3 py-2 text-right font-medium">Cost</th>
                <th className="px-3 py-2 text-left font-medium">Started</th>
              </tr>
            </thead>
            <tbody>
              {runs.length === 0 && (
                <tr>
                  <td className="text-muted-foreground px-3 py-4" colSpan={7}>
                    No runs recorded yet.
                  </td>
                </tr>
              )}
              {runs.map((run) => (
                <tr key={run.id} className="border-border border-t align-top">
                  <td className="px-3 py-2 font-mono text-xs">{run.kind}</td>
                  <td className="px-3 py-2">{run.propertyName ?? '—'}</td>
                  <td className="px-3 py-2">
                    <span className={`rounded px-1.5 py-0.5 text-xs ${STATUS_STYLE[run.status]}`}>
                      {run.status}
                    </span>
                    {run.error && (
                      <div className="text-muted-foreground mt-1 max-w-md text-xs">{run.error}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{duration(run.durationMs)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{run.rowsWritten}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {run.costUsd > 0 ? usd(run.costUsd) : '—'}
                  </td>
                  <td className="text-muted-foreground px-3 py-2 text-xs">
                    {relative(run.startedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
