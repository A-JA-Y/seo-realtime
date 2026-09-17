import { beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * The DEMO_MODE gate on `bootstrap-demo`.
 *
 * The cron secret authorises running jobs. It does not authorise filling a
 * database with synthetic history, and a production project must be immune to
 * that even if the secret leaks. So the gate is tested on its own: with the
 * flag off, the seed must not be CALLED — not merely fail afterwards.
 */
const seed = vi.fn();
const seedDemoData = vi.fn();
const demoProperty = vi.fn();

vi.mock('@/server/db/seed', () => ({ seed: () => seed() }));
vi.mock('@/server/db/demo', () => ({
  seedDemoData: (id: string) => seedDemoData(id),
  demoProperty: () => demoProperty(),
}));
vi.mock('@/server/alerts/engine', () => ({ runAlertsForProperty: vi.fn() }));
vi.mock('@/server/ingest/gsc', () => ({
  backfillGsc: vi.fn(),
  forEachActiveProperty: vi.fn(),
  ingestGscHourly: vi.fn(),
  reconcileGscFinal: vi.fn(),
}));
vi.mock('@/server/ingest/serp', () => ({ enqueueSerpBatch: vi.fn() }));
vi.mock('./retention', () => ({ runPruneJob: vi.fn() }));
vi.mock('./rollups', () => ({ runRollupJob: vi.fn() }));

async function jobsWith(demoMode: string | undefined) {
  vi.resetModules();
  vi.doMock('@/lib/env', () => ({ env: { DEMO_MODE: demoMode } }));
  const { JOBS } = await import('./cron-jobs');
  return JOBS;
}

beforeEach(() => {
  for (const fn of [seed, seedDemoData, demoProperty]) fn.mockReset();
  seed.mockResolvedValue({
    organization: { name: 'Agency', slug: 'agency' },
    property: { id: 'p1', name: 'Demo', gscSiteUrl: 'https://x/' },
    keywords: 13,
    targets: 26,
    adminEmail: 'demo-admin@example.com',
    clientEmail: 'demo-client@example.com',
    generatedPassword: null,
    generatedClientPassword: null,
  });
  demoProperty.mockResolvedValue({ id: 'p1', name: 'Demo' });
  seedDemoData.mockResolvedValue({
    property: { id: 'p1', name: 'Demo' },
    gscRows: 337,
    checkRows: 3016,
    rollups: 754,
    alertsRaised: 29,
    alertsOpen: 16,
  });
});

describe('bootstrap-demo', () => {
  it.each([undefined, '0', 'false', ''])(
    'refuses to touch the database when DEMO_MODE is %j',
    async (flag) => {
      const JOBS = await jobsWith(flag);
      const outcome = await JOBS['bootstrap-demo']!();

      expect(outcome.status).toBe('failed');
      expect(seed).not.toHaveBeenCalled();
      expect(seedDemoData).not.toHaveBeenCalled();
      expect(JSON.stringify(outcome.detail)).toContain('DEMO_MODE');
    },
  );

  it.each(['1', 'true'])('seeds accounts and data when DEMO_MODE is %j', async (flag) => {
    const JOBS = await jobsWith(flag);
    const outcome = await JOBS['bootstrap-demo']!();

    expect(outcome.status).toBe('success');
    expect(seed).toHaveBeenCalledTimes(1);
    expect(seedDemoData).toHaveBeenCalledWith('p1');
    expect(outcome.detail).toMatchObject({
      accounts: { admin: 'demo-admin@example.com', client: 'demo-client@example.com' },
      serpChecks: 3016,
      synthetic: true,
    });
  });

  // Acceptance criterion 12 reaches the bootstrap too: a password minted because
  // none was set goes to the server log once, and never into a response.
  it('never returns a generated password', async () => {
    seed.mockResolvedValueOnce({
      organization: { name: 'Agency', slug: 'agency' },
      property: { id: 'p1', name: 'Demo', gscSiteUrl: 'https://x/' },
      keywords: 1,
      targets: 1,
      adminEmail: 'demo-admin@example.com',
      clientEmail: null,
      generatedPassword: 'hunter2-minted-XYZ',
      generatedClientPassword: null,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const JOBS = await jobsWith('1');
    const outcome = await JOBS['bootstrap-demo']!();

    expect(JSON.stringify(outcome)).not.toContain('hunter2-minted-XYZ');
    // …but it did reach the log, once.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('hunter2-minted-XYZ');
    warn.mockRestore();
  });
});
