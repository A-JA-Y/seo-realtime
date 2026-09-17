import { redactError } from '@/lib/redact';
import {
  backfillGsc,
  forEachActiveProperty,
  ingestGscHourly,
  reconcileGscFinal,
} from '@/server/ingest/gsc';
import { enqueueSerpBatch } from '@/server/ingest/serp';
import { runAlertsForProperty } from '@/server/alerts/engine';
import { env } from '@/lib/env';
import { demoProperty, seedDemoData } from '@/server/db/demo';
import { seed } from '@/server/db/seed';
import { runPruneJob } from './retention';
import { runRollupJob } from './rollups';

/**
 * The cron job registry (§7).
 *
 * Separate from the route because a Next.js route file may only export its
 * handlers and route config — and because the dispatch table is worth testing
 * without standing up an HTTP request.
 */

export interface JobOutcome {
  job: string;
  status: 'success' | 'partial' | 'failed';
  detail: unknown;
}

/**
 * Run a per-property job across every active property.
 *
 * §7: "Status `partial` when some properties succeed." The three-way split
 * matters on /ops — an all-failed run is an outage and a partial run is a
 * degradation, and conflating them hides the difference.
 */
export async function perProperty(
  job: string,
  fn: (propertyId: string) => Promise<unknown>,
): Promise<JobOutcome> {
  const { succeeded, failed } = await forEachActiveProperty(fn);

  const status =
    failed.length === 0 ? 'success' : succeeded.length === 0 ? 'failed' : 'partial';

  return {
    job,
    status,
    detail: { properties: succeeded.length + failed.length, succeeded: succeeded.length, failed },
  };
}

/**
 * The daily chain.
 *
 * Vercel Hobby allows very few cron entries, so `vercel.json` registers exactly
 * one and it runs reconcile → rollup → prune in order. Each step is still
 * individually addressable for the external scheduler and for manual re-runs.
 *
 * The order is load-bearing: `prune` deletes per-check rows only for days that
 * already have a rollup, so running it before `rollup` would defer deletions
 * rather than corrupt anything — but running it after keeps storage bounded on
 * the first pass.
 */
async function runDaily(): Promise<JobOutcome> {
  const steps: JobOutcome[] = [];

  steps.push(await perProperty('reconcile-gsc', (id) => reconcileGscFinal(id)));

  for (const [job, fn] of [
    ['rollup', runRollupJob],
    ['prune', runPruneJob],
  ] as const) {
    try {
      steps.push({ job, status: 'success', detail: await fn() });
    } catch (error) {
      // One failing step must not skip the next: pruning is what keeps the
      // database inside Neon's free tier.
      steps.push({ job, status: 'failed', detail: { error: redactError(error) } });
    }
  }

  /*
   * Alerts run AFTER the rollup, never before.
   *
   * §9 says baselines come from `daily_rank_rollups`, so an engine that ran
   * first would evaluate today against a rollup that does not exist yet and
   * quietly find nothing — a silent no-op, which is the worst failure mode an
   * alerting system has.
   */
  steps.push(await perProperty('alerts', (id) => runAlertsForProperty(id)));

  const failed = steps.filter((s) => s.status === 'failed').length;

  return {
    job: 'daily',
    status: failed === 0 ? 'success' : failed === steps.length ? 'failed' : 'partial',
    detail: steps,
  };
}

export const JOBS: Record<string, () => Promise<JobOutcome>> = {
  'ingest-gsc': () => perProperty('ingest-gsc', (id) => ingestGscHourly(id)),
  'reconcile-gsc': () => perProperty('reconcile-gsc', (id) => reconcileGscFinal(id)),

  /*
   * The backfill shares ONE deadline across every property, rather than giving
   * each its own budget: ten properties at 45 seconds each would ask for 450
   * inside a 60-second function. An unfinished run returns `partial` and the
   * next invocation resumes from the per-keyword cursors.
   */
  'backfill-gsc': async () => {
    const deadline = Date.now() + 45_000;
    return perProperty('backfill-gsc', (id) => backfillGsc(id, { deadline }));
  },

  'enqueue-serp': async () => {
    const result = await enqueueSerpBatch();
    return {
      job: 'enqueue-serp',
      status: result.tasksRejected === 0 ? 'success' : result.tasksSubmitted === 0 ? 'failed' : 'partial',
      detail: result,
    };
  },

  rollup: async () => ({ job: 'rollup', status: 'success', detail: await runRollupJob() }),
  alerts: () => perProperty('alerts', (id) => runAlertsForProperty(id)),

  /*
   * `prune` reports the status its own run recorded, not a hard-coded success.
   *
   * `runPruneJob` catches its failures internally so one broken step cannot
   * skip the next, and marks the ingest_run partial or failed accordingly — but
   * the dispatcher then answered HTTP 200 'success' regardless. An external
   * scheduler watching exit codes saw a green tick while retention was failing,
   * which is the one job whose silent failure fills the database.
   */
  prune: async () => {
    const detail = await runPruneJob();
    // A finished run is never 'running'; narrow rather than widen JobOutcome,
    // which deliberately has no in-flight state.
    const status = detail.status === 'running' ? 'success' : detail.status;
    return { job: 'prune', status, detail };
  },
  daily: runDaily,

  /*
   * Seed the demo accounts and 28 days of SYNTHETIC history into this
   * deployment, so a hosted instance can be made demonstrable without a local
   * Postgres client.
   *
   * Gated on DEMO_MODE, and the gate is not advisory. The cron secret
   * authorises running jobs; it does not authorise filling a database with
   * fiction, and anyone who obtained it should still be unable to. A production
   * project simply never sets DEMO_MODE, and this job answers `failed` without
   * touching a row.
   *
   * The passwords come from SEED_ADMIN_PASSWORD / SEED_CLIENT_PASSWORD in the
   * deployment's own environment, and are never returned: a password minted
   * here because none was set is written to the server log ONCE and nowhere
   * else. This response carries emails only.
   */
  'bootstrap-demo': async () => {
    if (env.DEMO_MODE !== '1' && env.DEMO_MODE !== 'true') {
      return {
        job: 'bootstrap-demo',
        status: 'failed',
        detail: {
          error:
            'DEMO_MODE is not enabled on this deployment. Set DEMO_MODE=1 in the environment ' +
            'to allow synthetic data to be seeded here. Never enable it on a production project.',
        },
      };
    }

    const seeded = await seed();
    const demo = await seedDemoData((await demoProperty()).id);

    if (seeded.generatedPassword || seeded.generatedClientPassword) {
      // Once, to the log, redacted from any response. Set SEED_*_PASSWORD to
      // choose them instead — that is what a demo should do.
      console.warn(
        JSON.stringify({
          level: 'warn',
          job: 'bootstrap-demo',
          message: 'passwords were generated because SEED_*_PASSWORD was not set; shown once',
          ...(seeded.generatedPassword ? { admin_password: seeded.generatedPassword } : {}),
          ...(seeded.generatedClientPassword
            ? { client_password: seeded.generatedClientPassword }
            : {}),
        }),
      );
    }

    return {
      job: 'bootstrap-demo',
      status: 'success',
      detail: {
        accounts: {
          admin: seeded.adminEmail,
          client: seeded.clientEmail,
          passwords: 'as set in SEED_ADMIN_PASSWORD / SEED_CLIENT_PASSWORD (never returned here)',
        },
        property: demo.property.name,
        keywords: seeded.keywords,
        targets: seeded.targets,
        searchConsoleRows: demo.gscRows,
        serpChecks: demo.checkRows,
        rollups: demo.rollups,
        alertsRaised: demo.alertsRaised,
        synthetic: true,
      },
    };
  },
};

export const CRON_JOBS = Object.keys(JOBS);


