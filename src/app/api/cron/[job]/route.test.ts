import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SECRET = 'test-cron-secret-000000000000000000000';

const ingestGsc = vi.fn();
const enqueueSerp = vi.fn();
const rollup = vi.fn();
const prune = vi.fn();

vi.mock('@/server/ops/cron-jobs', () => ({
  CRON_JOBS: ['ingest-gsc', 'enqueue-serp', 'rollup', 'prune', 'daily'],
  JOBS: {
    'ingest-gsc': () => ingestGsc(),
    'enqueue-serp': () => enqueueSerp(),
    rollup: () => rollup(),
    prune: () => prune(),
  },
}));

const BASE = 'https://rank.example.com/api/cron';
const params = (job: string) => ({ params: Promise.resolve({ job }) });

async function load() {
  process.env.CRON_SECRET = SECRET;
  vi.resetModules();
  return import('./route');
}

beforeEach(() => {
  for (const fn of [ingestGsc, enqueueSerp, rollup, prune]) fn.mockReset();
  ingestGsc.mockResolvedValue({ job: 'ingest-gsc', status: 'success', detail: {} });
  enqueueSerp.mockResolvedValue({ job: 'enqueue-serp', status: 'success', detail: {} });
});

afterEach(() => vi.restoreAllMocks());

describe('cron dispatcher authentication', () => {
  it('rejects a request with no secret, without running the job', async () => {
    // Without this the endpoint is a public button that spends the balance.
    const { POST } = await load();
    const response = await POST(new Request(`${BASE}/enqueue-serp`, { method: 'POST' }), params('enqueue-serp'));

    expect(response.status).toBe(401);
    expect(enqueueSerp).not.toHaveBeenCalled();
  });

  it('rejects a wrong secret', async () => {
    const { POST } = await load();
    const response = await POST(
      new Request(`${BASE}/enqueue-serp`, {
        method: 'POST',
        headers: { authorization: 'Bearer wrong' },
      }),
      params('enqueue-serp'),
    );

    expect(response.status).toBe(401);
    expect(enqueueSerp).not.toHaveBeenCalled();
  });

  it('rejects a correct PREFIX of the secret', async () => {
    const { POST } = await load();
    const response = await POST(
      new Request(`${BASE}/rollup`, {
        method: 'POST',
        headers: { authorization: `Bearer ${SECRET.slice(0, -1)}` },
      }),
      params('rollup'),
    );

    expect(response.status).toBe(401);
  });

  it('accepts the Bearer header Vercel cron sends', async () => {
    const { POST } = await load();
    const response = await POST(
      new Request(`${BASE}/ingest-gsc`, {
        method: 'POST',
        headers: { authorization: `Bearer ${SECRET}` },
      }),
      params('ingest-gsc'),
    );

    expect(response.status).toBe(200);
    expect(ingestGsc).toHaveBeenCalled();
  });

  it('accepts ?secret= on GET, for a scheduler that cannot set headers', async () => {
    // §7 requires both paths: a free external scheduler drives the hourly jobs.
    const { GET } = await load();
    const response = await GET(
      new Request(`${BASE}/ingest-gsc?secret=${SECRET}`),
      params('ingest-gsc'),
    );

    expect(response.status).toBe(200);
    expect(ingestGsc).toHaveBeenCalled();
  });

  it('does not leak the secret into the 401 body', async () => {
    const { POST } = await load();
    const response = await POST(
      new Request(`${BASE}/rollup?secret=wrong`, { method: 'POST' }),
      params('rollup'),
    );

    expect(await response.text()).not.toContain(SECRET);
  });
});

describe('cron dispatcher routing', () => {
  it('404s an unknown job and names the known ones', async () => {
    // A typo in a scheduler config would otherwise look like a job that ran
    // and did nothing.
    const { POST } = await load();
    const response = await POST(
      new Request(`${BASE}/ingset-gsc?secret=${SECRET}`, { method: 'POST' }),
      params('ingset-gsc'),
    );

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.code).toBe('UNKNOWN_JOB');
    expect(body.known).toContain('ingest-gsc');
  });

  it('returns 500 for a failed job so the scheduler alerts', async () => {
    // The opposite of the pingback route: a scheduler retrying a cron is fine,
    // whereas DataForSEO would redeliver forever.
    enqueueSerp.mockResolvedValue({ job: 'enqueue-serp', status: 'failed', detail: {} });

    const { POST } = await load();
    const response = await POST(
      new Request(`${BASE}/enqueue-serp?secret=${SECRET}`, { method: 'POST' }),
      params('enqueue-serp'),
    );

    expect(response.status).toBe(500);
  });

  it('returns 200 for a partial job', async () => {
    enqueueSerp.mockResolvedValue({ job: 'enqueue-serp', status: 'partial', detail: {} });

    const { POST } = await load();
    const response = await POST(
      new Request(`${BASE}/enqueue-serp?secret=${SECRET}`, { method: 'POST' }),
      params('enqueue-serp'),
    );

    expect(response.status).toBe(200);
    expect((await response.json()).status).toBe('partial');
  });

  it('returns 500 rather than throwing when a job throws', async () => {
    enqueueSerp.mockRejectedValue(new Error('boom'));

    const { POST } = await load();
    const response = await POST(
      new Request(`${BASE}/enqueue-serp?secret=${SECRET}`, { method: 'POST' }),
      params('enqueue-serp'),
    );

    expect(response.status).toBe(500);
    expect((await response.json()).code).toBe('UNHANDLED');
  });

  it('does not leak a secret from a thrown error', async () => {
    enqueueSerp.mockRejectedValue(new Error('postgresql://u:hunter2@db/x failed'));

    const { POST } = await load();
    const response = await POST(
      new Request(`${BASE}/enqueue-serp?secret=${SECRET}`, { method: 'POST' }),
      params('enqueue-serp'),
    );

    const body = await response.text();
    expect(body).not.toContain('hunter2');
    expect(body).not.toContain(SECRET);
  });

  it('reports the duration', async () => {
    const { POST } = await load();
    const response = await POST(
      new Request(`${BASE}/rollup?secret=${SECRET}`, { method: 'POST' }),
      params('rollup'),
    );

    rollup.mockResolvedValue({ job: 'rollup', status: 'success', detail: {} });
    expect(typeof (await response.json()).durationMs).toBe('number');
  });
});
