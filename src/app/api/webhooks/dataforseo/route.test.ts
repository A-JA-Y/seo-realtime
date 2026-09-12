import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SECRET = 'test-pingback-secret-0000000000000000';

/**
 * The route is tested through its real handler, with only the ingest layer
 * mocked. The thing under test is the security boundary and the
 * always-200 contract, and both live in the route.
 */
const handleSerpPingback = vi.fn();

vi.mock('@/server/ingest/serp', () => ({
  handleSerpPingback: (...args: unknown[]) => handleSerpPingback(...args),
}));

const BASE = 'https://rank.example.com/api/webhooks/dataforseo';

async function load() {
  process.env.DATAFORSEO_PINGBACK_SECRET = SECRET;
  vi.resetModules();
  return import('./route');
}

beforeEach(() => {
  handleSerpPingback.mockReset();
  handleSerpPingback.mockResolvedValue({
    status: 'recorded',
    serpCheckId: 1,
    keywordTargetId: 'target-1',
    found: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api/webhooks/dataforseo', () => {
  describe('authentication', () => {
    it('rejects a request with no secret', async () => {
      const { POST } = await load();
      const response = await POST(new Request(`${BASE}?id=task-1`, { method: 'POST' }));

      expect(response.status).toBe(401);
      // Crucially: no task_get was issued. Every unauthenticated hit that
      // reached the ingest would be a billed call.
      expect(handleSerpPingback).not.toHaveBeenCalled();
    });

    it('rejects a wrong secret', async () => {
      const { POST } = await load();
      const response = await POST(new Request(`${BASE}?secret=wrong&id=task-1`, { method: 'POST' }));

      expect(response.status).toBe(401);
      expect(handleSerpPingback).not.toHaveBeenCalled();
    });

    it('rejects a correct PREFIX of the secret', async () => {
      const { POST } = await load();
      const response = await POST(
        new Request(`${BASE}?secret=${SECRET.slice(0, -1)}&id=task-1`, { method: 'POST' }),
      );

      expect(response.status).toBe(401);
    });

    it('accepts the correct secret', async () => {
      const { POST } = await load();
      const response = await POST(
        new Request(`${BASE}?secret=${SECRET}&id=task-1`, { method: 'POST' }),
      );

      expect(response.status).toBe(200);
      expect(handleSerpPingback).toHaveBeenCalledWith('task-1');
    });

    it('returns no detail in the 401 body', async () => {
      const { POST } = await load();
      const response = await POST(new Request(`${BASE}?secret=wrong&id=x`, { method: 'POST' }));
      const body = await response.text();

      expect(body).toBe('Unauthorized');
      expect(body).not.toContain(SECRET);
    });
  });

  describe('the always-200 contract', () => {
    it('returns 200 when the ingest reports a failure', async () => {
      // A non-200 makes DataForSEO redeliver forever, re-billing task_get
      // each time. Failures go to ingest_runs, not to the status code.
      handleSerpPingback.mockResolvedValue({ status: 'failed', reason: 'parse error' });

      const { POST } = await load();
      const response = await POST(
        new Request(`${BASE}?secret=${SECRET}&id=task-1`, { method: 'POST' }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: 'failed' });
    });

    it('returns 200 even when the ingest THROWS', async () => {
      handleSerpPingback.mockRejectedValue(new Error('unexpected'));

      const { POST } = await load();
      const response = await POST(
        new Request(`${BASE}?secret=${SECRET}&id=task-1`, { method: 'POST' }),
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status: 'failed', code: 'UNHANDLED' });
    });

    it('does not leak a secret from a thrown error into the response', async () => {
      handleSerpPingback.mockRejectedValue(
        new Error(`connect postgresql://u:hunter2@db.neon.tech/main failed`),
      );

      const { POST } = await load();
      const response = await POST(
        new Request(`${BASE}?secret=${SECRET}&id=task-1`, { method: 'POST' }),
      );

      const body = await response.text();
      expect(body).not.toContain('hunter2');
      expect(body).not.toContain(SECRET);
    });
  });

  describe('task id handling', () => {
    it('returns 200 and ignores a request with no id', async () => {
      const { POST } = await load();
      const response = await POST(new Request(`${BASE}?secret=${SECRET}`, { method: 'POST' }));

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ code: 'MISSING_TASK_ID' });
      expect(handleSerpPingback).not.toHaveBeenCalled();
    });

    it('detects an unsubstituted $id — a misconfigured pingback URL', async () => {
      // If this fires, every result is being lost. It must not look like a
      // normal empty delivery.
      const { POST } = await load();
      const response = await POST(
        new Request(`${BASE}?secret=${SECRET}&id=%24id`, { method: 'POST' }),
      );

      expect(await response.json()).toMatchObject({ code: 'MISSING_TASK_ID' });
      expect(handleSerpPingback).not.toHaveBeenCalled();
    });
  });

  describe('GET', () => {
    it('is accepted too, with the same auth rules', async () => {
      const { GET } = await load();

      expect((await GET(new Request(`${BASE}?id=task-1`))).status).toBe(401);
      expect((await GET(new Request(`${BASE}?secret=${SECRET}&id=task-1`))).status).toBe(200);
    });
  });
});
