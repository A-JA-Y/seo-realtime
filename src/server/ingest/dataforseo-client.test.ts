import { describe, expect, it, vi } from 'vitest';

import { HttpError } from '@/lib/retry';
import taskPostResponse from '@/test/fixtures/dataforseo/task-post-response.json';

import {
  COST_PER_SERP,
  MAX_TASKS_PER_POST,
  buildPingbackUrl,
  createDataForSeoClient,
  isTaskOk,
  type SerpTaskRequest,
} from './dataforseo-client';

const task = (overrides: Partial<SerpTaskRequest> = {}): SerpTaskRequest => ({
  keyword: 'prestige sector 150 noida',
  location_code: 1007742,
  language_code: 'en',
  device: 'mobile',
  os: 'android',
  depth: 100,
  tag: 'target-1',
  ...overrides,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function client(fetchImpl: typeof fetch) {
  return createDataForSeoClient({
    fetchImpl,
    authHeader: () => 'Basic dGVzdDp0ZXN0',
    retry: { sleep: () => Promise.resolve(), random: () => 1 },
  });
}

describe('pricing constants', () => {
  it('matches §17', () => {
    // Standard is 3.3x cheaper than live. Getting these wrong misreports spend
    // on /ops, which is the number the whole cost model rests on.
    expect(COST_PER_SERP.standard).toBe(0.0006);
    expect(COST_PER_SERP.priority).toBe(0.0012);
    expect(COST_PER_SERP.live).toBe(0.002);
    expect(MAX_TASKS_PER_POST).toBe(100);
  });
});

describe('isTaskOk', () => {
  it('accepts Ok and Task Created', () => {
    expect(isTaskOk(20000)).toBe(true);
    expect(isTaskOk(20100)).toBe(true);
  });

  it('rejects every error code', () => {
    for (const code of [40102, 40401, 40501, 40602, 50000]) {
      expect(isTaskOk(code), `code ${code}`).toBe(false);
    }
  });
});

describe('taskPost', () => {
  it('sends the tasks as a JSON array', async () => {
    const fetchImpl = vi.fn(async () => json({ status_code: 20000, tasks: [] })) as unknown as typeof fetch;
    await client(fetchImpl).taskPost([task(), task({ tag: 'target-2' })]);

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toContain('/v3/serp/google/organic/task_post');
    expect((init as RequestInit).method).toBe('POST');

    const body = JSON.parse((init as RequestInit).body as string);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
  });

  it('refuses more than 100 tasks rather than having them silently rejected', async () => {
    const fetchImpl = vi.fn(async () => json({ status_code: 20000 })) as unknown as typeof fetch;
    const tasks = Array.from({ length: 101 }, (_, i) => task({ tag: `t${i}` }));

    await expect(client(fetchImpl).taskPost(tasks)).rejects.toThrow(/at most 100/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses an empty batch', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(client(fetchImpl).taskPost([])).rejects.toThrow(/no tasks/);
  });

  it('surfaces per-task failures in the envelope', async () => {
    const fetchImpl = vi.fn(async () => json(taskPostResponse)) as unknown as typeof fetch;
    const envelope = await client(fetchImpl).taskPost([task(), task({ tag: 'TARGET_B' })]);

    // Envelope 20000, but one task failed. Both must be visible.
    expect(envelope.status_code).toBe(20000);
    expect(envelope.tasks?.map((t) => t.status_code)).toEqual([20100, 40501]);
    expect(envelope.tasks?.[1]?.data?.tag).toBe('TARGET_B');
  });

  it('does NOT retry a connection reset — task_post bills on acceptance', async () => {
    // A reset after the server accepted the batch would double-charge.
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    }) as unknown as typeof fetch;

    await expect(client(fetchImpl).taskPost([task()])).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it('DOES retry a 429 — that means rejected, not accepted', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      return calls === 1 ? json({}, 429) : json({ status_code: 20000, tasks: [] });
    }) as unknown as typeof fetch;

    await client(fetchImpl).taskPost([task()]);
    expect(calls).toBe(2);
  });
});

describe('taskGetAdvanced', () => {
  it('URL-encodes the task id into the path', async () => {
    const fetchImpl = vi.fn(async () => json({ status_code: 20000, tasks: [] })) as unknown as typeof fetch;
    await client(fetchImpl).taskGetAdvanced('09121400-1234/../etc');

    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toContain('/task_get/advanced/09121400-1234%2F..%2Fetc');
  });
});

describe('authentication failures', () => {
  it('explains that the API password is not the login password', async () => {
    // The single most common DataForSEO setup mistake.
    const fetchImpl = vi.fn(async () => json({}, 401)) as unknown as typeof fetch;

    const error = await client(fetchImpl)
      .balance()
      .catch((e: unknown) => e as HttpError);

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(401);
    expect((error as HttpError).message).toMatch(/not your account login password/);
  });

  it('does not retry a 401', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      return json({}, 401);
    }) as unknown as typeof fetch;

    await expect(client(fetchImpl).balance()).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

describe('response validation', () => {
  it('rejects a malformed envelope rather than coercing it', async () => {
    const fetchImpl = vi.fn(async () => json({ status_code: 'ok' })) as unknown as typeof fetch;
    await expect(client(fetchImpl).taskGetAdvanced('x')).rejects.toThrow(/unexpected response shape/);
  });

  it('tolerates unknown fields the provider adds later', async () => {
    const fetchImpl = vi.fn(async () =>
      json({ status_code: 20000, brand_new_field: true, tasks: [] }),
    ) as unknown as typeof fetch;

    await expect(client(fetchImpl).taskGetAdvanced('x')).resolves.toMatchObject({
      status_code: 20000,
    });
  });
});

describe('buildPingbackUrl', () => {
  it('carries the secret and leaves $id for the provider to substitute', () => {
    const url = buildPingbackUrl('https://rank.example.com', 'sekrit');
    expect(url).toBe('https://rank.example.com/api/webhooks/dataforseo?secret=sekrit&id=$id');
  });

  it('does not double the slash when the base has a trailing one', () => {
    expect(buildPingbackUrl('https://rank.example.com/', 's')).toContain(
      'https://rank.example.com/api/webhooks',
    );
  });

  it('URL-encodes a secret containing reserved characters', () => {
    const url = buildPingbackUrl('https://x.test', 'a&b=c d');
    expect(url).toContain('secret=a%26b%3Dc%20d');
    expect(url).toMatch(/&id=\$id$/);
  });
});
