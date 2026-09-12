import { describe, expect, it, vi } from 'vitest';

import { HttpError } from '@/lib/retry';
import bareHour from '@/test/fixtures/gsc/hourly-bare-hour.json';
import dailyFinal from '@/test/fixtures/gsc/daily-final.json';
import empty from '@/test/fixtures/gsc/empty.json';
import isoHour from '@/test/fixtures/gsc/hourly-combined-iso.json';
import sparse from '@/test/fixtures/gsc/sparse-and-degenerate.json';

import {
  createGscClient,
  encodeSiteUrl,
  exactQueryFilter,
  parseDateKey,
  parseHourKey,
  searchAnalyticsResponseSchema,
} from './gsc-client';

const okHeaders = async () => new Headers({ authorization: 'Bearer test-token' });

function stubFetch(responses: Array<Response | (() => Response)>) {
  let call = 0;
  return vi.fn(async () => {
    const next = responses[Math.min(call, responses.length - 1)];
    call++;
    return typeof next === 'function' ? next() : next!.clone();
  }) as unknown as typeof fetch;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function client(fetchImpl: typeof fetch) {
  return createGscClient({
    fetchImpl,
    authorize: okHeaders,
    // No real sleeping in a retry path.
    retry: { sleep: () => Promise.resolve(), random: () => 1 },
  });
}

/* ══════════════════════════════════════════════════════════════════════════
   Dimension key parsing — the ambiguity Google's docs leave open
   ══════════════════════════════════════════════════════════════════════════ */

describe('parseHourKey', () => {
  it('parses a bare hour', () => {
    expect(parseHourKey('0')).toBe(0);
    expect(parseHourKey('9')).toBe(9);
    expect(parseHourKey('09')).toBe(9);
    expect(parseHourKey('13')).toBe(13);
    expect(parseHourKey('23')).toBe(23);
  });

  it('parses an ISO timestamp key', () => {
    expect(parseHourKey('2026-09-11T13:00:00-07:00')).toBe(13);
    expect(parseHourKey('2026-09-11T00:00:00-08:00')).toBe(0);
    expect(parseHourKey('2026-09-11 21:00:00-07:00')).toBe(21);
  });

  it('takes the hour LITERALLY, without a timezone round trip', () => {
    // The string is already Pacific local time. Parsing it into a Date and
    // reading getHours() would convert through the runtime's zone — in a
    // UTC container, 13:00-07:00 becomes 20:00. That is exactly the silent
    // date/hour shift domain rule 4 forbids.
    const key = '2026-09-11T13:00:00-07:00';
    expect(parseHourKey(key)).toBe(13);
    expect(new Date(key).getUTCHours()).toBe(20); // what the wrong approach yields
  });

  it('rejects out-of-range and unparseable keys rather than guessing', () => {
    expect(parseHourKey('24')).toBeNull();
    expect(parseHourKey('-1')).toBeNull();
    expect(parseHourKey('noon')).toBeNull();
    expect(parseHourKey('')).toBeNull();
    expect(parseHourKey('2026-09-11')).toBeNull();
  });
});

describe('parseDateKey', () => {
  it('reads the literal date prefix from either key shape', () => {
    expect(parseDateKey('2026-09-11')).toBe('2026-09-11');
    expect(parseDateKey('2026-09-11T13:00:00-07:00')).toBe('2026-09-11');
  });

  it('returns null for a bare hour key', () => {
    expect(parseDateKey('13')).toBeNull();
    expect(parseDateKey('not a date')).toBeNull();
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   Response validation
   ══════════════════════════════════════════════════════════════════════════ */

describe('searchAnalyticsResponseSchema', () => {
  it('parses a combined date+hour response', () => {
    const parsed = searchAnalyticsResponseSchema.parse(isoHour);
    expect(parsed.rows).toHaveLength(4);
    expect(parsed.rows[1]).toMatchObject({ clicks: 1, impressions: 12, position: 9.5 });
  });

  it('parses a daily final response', () => {
    const parsed = searchAnalyticsResponseSchema.parse(dailyFinal);
    expect(parsed.rows.map((r) => r.position)).toEqual([35.09, 31.5, 15.2, 13.4, 7.8]);
  });

  it('treats a response with no rows key as zero rows, not an error', () => {
    // A 200 with no rows means "no impressions in the window" — a pass.
    expect(searchAnalyticsResponseSchema.parse(empty).rows).toEqual([]);
  });

  it('defaults omitted metrics to zero but leaves position UNDEFINED', () => {
    // Google omits fields rather than sending zero. A missing position is
    // information; filling it with 0 would fabricate a number-one ranking.
    const parsed = searchAnalyticsResponseSchema.parse(sparse);

    expect(parsed.rows[0]).toMatchObject({ impressions: 0, clicks: 0, ctr: 0 });
    expect(parsed.rows[0]!.position).toBeUndefined();

    expect(parsed.rows[1]).toMatchObject({ impressions: 1, position: 6 });
    expect(parsed.rows[1]!.clicks).toBe(0);

    expect(parsed.rows[2]).toMatchObject({ clicks: 0, impressions: 0, ctr: 0 });
    expect(parsed.rows[2]!.position).toBeUndefined();
  });

  it('strips unknown fields rather than failing the whole ingest', () => {
    // Google adds response fields without notice. A strict schema would turn a
    // harmless addition into a total outage.
    const parsed = searchAnalyticsResponseSchema.parse({
      rows: [{ keys: ['2026-09-12'], clicks: 1, impressions: 2, ctr: 0.5, position: 3, futureField: 'x' }],
      someNewTopLevelField: true,
    });

    expect(parsed.rows[0]).not.toHaveProperty('futureField');
    expect(parsed.rows[0]!.position).toBe(3);
  });

  it('REJECTS a field of the wrong type instead of coercing it', () => {
    // §5: "Reject and log anything unexpected rather than coercing."
    expect(() => searchAnalyticsResponseSchema.parse({ rows: [{ impressions: '42' }] })).toThrow();
    expect(() => searchAnalyticsResponseSchema.parse({ rows: [{ position: 'top' }] })).toThrow();
    expect(() => searchAnalyticsResponseSchema.parse({ rows: [{ keys: [1, 2] }] })).toThrow();
  });

  it('rejects impossible metric values', () => {
    expect(() => searchAnalyticsResponseSchema.parse({ rows: [{ impressions: -1 }] })).toThrow();
    expect(() => searchAnalyticsResponseSchema.parse({ rows: [{ position: 0 }] })).toThrow();
    expect(() => searchAnalyticsResponseSchema.parse({ rows: [{ clicks: Number.NaN }] })).toThrow();
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   siteUrl encoding
   ══════════════════════════════════════════════════════════════════════════ */

describe('encodeSiteUrl', () => {
  it('encodes a URL-prefix property including its trailing slash', () => {
    expect(encodeSiteUrl('https://prestigenoidasector150.com/')).toBe(
      'https%3A%2F%2Fprestigenoidasector150.com%2F',
    );
  });

  it('encodes a domain property', () => {
    expect(encodeSiteUrl('sc-domain:prestigenoidasector150.com')).toBe(
      'sc-domain%3Aprestigenoidasector150.com',
    );
  });
});

describe('exactQueryFilter', () => {
  it('pins the request to one keyword with an exact match', () => {
    // Google "does not guarantee to return all data rows but rather top ones",
    // so fetching everything and filtering client-side silently drops keywords.
    expect(exactQueryFilter('prestige sector 150 noida')).toEqual([
      {
        groupType: 'and',
        filters: [
          { dimension: 'query', operator: 'equals', expression: 'prestige sector 150 noida' },
        ],
      },
    ]);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   Transport behaviour
   ══════════════════════════════════════════════════════════════════════════ */

describe('createGscClient', () => {
  it('POSTs the query to the encoded site path', async () => {
    const fetchImpl = stubFetch([json(dailyFinal)]);
    const result = await client(fetchImpl).searchAnalytics('https://example.com/', {
      startDate: '2026-09-08',
      endDate: '2026-09-12',
      dimensions: ['date', 'query'],
      dataState: 'final',
    });

    expect(result.rows).toHaveLength(5);

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toContain('/sites/https%3A%2F%2Fexample.com%2F/searchAnalytics/query');
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({
      dataState: 'final',
      dimensions: ['date', 'query'],
    });
  });

  it('lists sites', async () => {
    const fetchImpl = stubFetch([
      json({ siteEntry: [{ siteUrl: 'https://example.com/', permissionLevel: 'siteRestrictedUser' }] }),
    ]);

    await expect(client(fetchImpl).listSites()).resolves.toEqual([
      { siteUrl: 'https://example.com/', permissionLevel: 'siteRestrictedUser' },
    ]);
  });

  it('surfaces a 400 immediately, without retrying', async () => {
    // The hourly job's dimension fallback keys off exactly this. A retry loop
    // that swallowed the 400 would turn "switch shapes" into "stop ingesting".
    const fetchImpl = stubFetch([() => json({ error: { message: 'invalid dimension' } }, 400)]);

    const error = await client(fetchImpl)
      .searchAnalytics('https://example.com/', {
        startDate: '2026-09-11',
        endDate: '2026-09-12',
        dimensions: ['date', 'hour', 'query'],
        dataState: 'hourly_all',
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(400);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not retry a 403 permission error', async () => {
    const fetchImpl = stubFetch([() => json({ error: { message: 'insufficient permission' } }, 403)]);
    await expect(client(fetchImpl).listSites()).rejects.toThrow(/403/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries a 503 and succeeds', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call++;
      return call === 1 ? json({ error: 'unavailable' }, 503) : json(dailyFinal);
    }) as unknown as typeof fetch;

    const result = await client(fetchImpl).searchAnalytics('https://example.com/', {
      startDate: '2026-09-08',
      endDate: '2026-09-12',
      dimensions: ['date', 'query'],
      dataState: 'final',
    });

    expect(result.rows).toHaveLength(5);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries a 429', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call++;
      return call === 1
        ? new Response('{}', { status: 429, headers: { 'retry-after': '1' } })
        : json(empty);
    }) as unknown as typeof fetch;

    await expect(client(fetchImpl).listSites()).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects a malformed response rather than coercing it', async () => {
    const fetchImpl = stubFetch([json({ rows: [{ impressions: 'many' }] })]);

    await expect(
      client(fetchImpl).searchAnalytics('https://example.com/', {
        startDate: '2026-09-12',
        endDate: '2026-09-12',
        dimensions: ['date', 'query'],
        dataState: 'final',
      }),
    ).rejects.toThrow(/unexpected response shape/);
  });

  it('sends the bearer token it was handed', async () => {
    const fetchImpl = stubFetch([json(empty)]);
    await client(fetchImpl).listSites();

    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const headers = (init as RequestInit).headers as Headers;
    expect(headers.get('authorization')).toBe('Bearer test-token');
  });

  it('parses the bare-hour fixture too', async () => {
    const fetchImpl = stubFetch([json(bareHour)]);
    const result = await client(fetchImpl).searchAnalytics('https://example.com/', {
      startDate: '2026-09-12',
      endDate: '2026-09-12',
      dimensions: ['hour', 'query'],
      dataState: 'hourly_all',
    });

    expect(result.rows.map((r) => parseHourKey(r.keys[0] ?? ''))).toEqual([0, 13, 23]);
  });
});
