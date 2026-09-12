import { describe, expect, it } from 'vitest';

import degenerateFixture from '@/test/fixtures/dataforseo/live-advanced-degenerate.json';
import foundFixture from '@/test/fixtures/dataforseo/live-advanced-found.json';
import notFoundFixture from '@/test/fixtures/dataforseo/live-advanced-not-found.json';

import {
  hostnameOf,
  isOwnDomain,
  parseProviderDatetime,
  parseSerpResult,
  serpEnvelopeSchema,
  trimSerpPayload,
} from './serp-parse';

const DOMAIN = 'prestigenoidasector150.com';

/** Pull `tasks[0].result[0]` the way the ingest does, through the schema. */
function resultOf(fixture: unknown) {
  const envelope = serpEnvelopeSchema.parse(fixture);
  const result = envelope.tasks?.[0]?.result?.[0];
  if (!result) throw new Error('fixture has no result');
  return result;
}

/* ══════════════════════════════════════════════════════════════════════════
   Domain matching — where a wrong answer looks exactly like a right one
   ══════════════════════════════════════════════════════════════════════════ */

describe('hostnameOf', () => {
  it('strips scheme, path and www', () => {
    expect(hostnameOf('https://www.example.com/a/b?c=d')).toBe('example.com');
    expect(hostnameOf('http://EXAMPLE.com')).toBe('example.com');
  });

  it('returns null rather than throwing on junk', () => {
    // One malformed URL among a hundred results must not cost the whole check.
    expect(hostnameOf('not a url')).toBeNull();
    expect(hostnameOf(null)).toBeNull();
    expect(hostnameOf(undefined)).toBeNull();
    expect(hostnameOf('')).toBeNull();
  });
});

describe('isOwnDomain', () => {
  it('matches the bare domain and www', () => {
    expect(isOwnDomain('https://example.com/', 'example.com')).toBe(true);
    expect(isOwnDomain('https://www.example.com/page', 'example.com')).toBe(true);
  });

  it('matches any page, not just the homepage', () => {
    // §6: "NOT full-URL equality" — that would miss every inner page.
    expect(isOwnDomain('https://example.com/floor-plan?utm=x#frag', 'example.com')).toBe(true);
  });

  it('matches a subdomain', () => {
    // Treating our own blog as a competitor would put the client's site in
    // their own competitor table.
    expect(isOwnDomain('https://blog.example.com/news', 'example.com')).toBe(true);
  });

  it('does NOT match a lookalike domain', () => {
    // The leading dot in the subdomain test is what stops this. Without it,
    // a competitor's rank would be recorded as ours.
    expect(isOwnDomain('https://notexample.com/', 'example.com')).toBe(false);
    expect(isOwnDomain('https://myexample.com/', 'example.com')).toBe(false);
  });

  it('does NOT match a domain that merely starts with ours', () => {
    expect(isOwnDomain('https://example.com.evil.test/', 'example.com')).toBe(false);
  });

  it('tolerates a stored domain written with www or a trailing slash', () => {
    expect(isOwnDomain('https://example.com/', 'www.example.com')).toBe(true);
    expect(isOwnDomain('https://example.com/', 'example.com/')).toBe(true);
  });

  it('is false for an unusable url', () => {
    expect(isOwnDomain(null, 'example.com')).toBe(false);
    expect(isOwnDomain('not a url', 'example.com')).toBe(false);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   parseSerpResult
   ══════════════════════════════════════════════════════════════════════════ */

describe('parseSerpResult — found', () => {
  const parsed = parseSerpResult(resultOf(foundFixture), DOMAIN);

  it('finds us', () => {
    expect(parsed.found).toBe(true);
  });

  it('separates rank_group from rank_absolute', () => {
    // Domain rule 2: two different measurements of one moment. rank_group is
    // which blue link you are; rank_absolute is how far down the page.
    expect(parsed.rankGroup).toBe(7);
    expect(parsed.rankAbsolute).toBe(13);
  });

  it('exposes a furniture gap of 6 — the whole point of storing both', () => {
    expect(parsed.rankAbsolute! - parsed.rankGroup!).toBe(6);
  });

  it('records the ranking URL', () => {
    // Domain rule 7: a stable position with a changed ranking URL is an event.
    expect(parsed.rankingUrl).toBe('https://prestigenoidasector150.com/');
  });

  it('takes the BEST rank_group when two of our URLs rank, and stores both', () => {
    // Domain rule 8.
    expect(parsed.allRankingUrls).toHaveLength(2);
    expect(parsed.allRankingUrls.map((u) => u.rank_group)).toEqual([7, 13]);
    expect(parsed.rankGroup).toBe(7);
  });

  it('lists competitors, excluding our own URLs', () => {
    expect(parsed.competingDomains.length).toBeLessThanOrEqual(10);
    expect(parsed.competingDomains.map((c) => c.domain)).not.toContain(DOMAIN);
    expect(parsed.competingDomains[0]).toMatchObject({ rank_group: 1, domain: '99acres.com' });
  });

  it('carries title and url for each competitor', () => {
    expect(parsed.competingDomains[0]).toMatchObject({
      url: expect.stringContaining('99acres.com'),
      title: expect.any(String),
    });
  });

  it('detects the SERP features sitting above us', () => {
    // A rank that held while an AI Overview appeared is a visibility LOSS.
    expect(parsed.serpFeatures).toEqual({
      ai_overview: true,
      local_pack: true,
      images: true,
      people_also_ask: true,
      video: true,
      top_stories: false,
      paid_count: 2,
    });
  });

  it('counts organic results only', () => {
    expect(parsed.organicResultCount).toBe(14);
  });

  it('uses the provider timestamp, not our receipt time', () => {
    expect(parsed.checkedAt?.toISOString()).toBe('2026-09-12T14:03:22.000Z');
  });
});

describe('parseSerpResult — not found', () => {
  const parsed = parseSerpResult(resultOf(notFoundFixture), DOMAIN);

  it('stores found=false with NULL ranks — never position 100', () => {
    // Domain rule 5 / acceptance criterion 4. A sentinel silently corrupts
    // every aggregate computed afterwards.
    expect(parsed.found).toBe(false);
    expect(parsed.rankGroup).toBeNull();
    expect(parsed.rankAbsolute).toBeNull();
    expect(parsed.rankingUrl).toBeNull();
    expect(parsed.allRankingUrls).toEqual([]);
  });

  it('still captures competitors — a miss is competitive intelligence too', () => {
    expect(parsed.competingDomains).toHaveLength(10);
    expect(parsed.organicResultCount).toBe(20);
  });
});

describe('parseSerpResult — degenerate input', () => {
  const parsed = parseSerpResult(resultOf(degenerateFixture), DOMAIN);

  it('matches the subdomain but NOT the lookalike or suffix-trick domains', () => {
    expect(parsed.found).toBe(true);
    expect(parsed.rankingUrl).toBe('https://blog.prestigenoidasector150.com/news');
    expect(parsed.allRankingUrls).toHaveLength(1);
  });

  it('treats the lookalikes as competitors', () => {
    const domains = parsed.competingDomains.map((c) => c.domain);
    expect(domains).toContain('notprestigenoidasector150.com');
    expect(domains).toContain('prestigenoidasector150.com.evil.example');
  });

  it('survives a null url, an unparseable url and an unknown item type', () => {
    expect(parsed.organicResultCount).toBe(5);
    expect(() => parseSerpResult(resultOf(degenerateFixture), DOMAIN)).not.toThrow();
  });

  it('omits a ranking URL that is null rather than storing a hole', () => {
    expect(parsed.allRankingUrls.every((u) => typeof u.url === 'string')).toBe(true);
  });
});

describe('parseSerpResult — empty and missing', () => {
  it('handles a result with no items at all', () => {
    const parsed = parseSerpResult({ items: null }, DOMAIN);
    expect(parsed.found).toBe(false);
    expect(parsed.organicResultCount).toBe(0);
    expect(parsed.competingDomains).toEqual([]);
    expect(parsed.serpFeatures.paid_count).toBe(0);
  });

  it('sorts nulls last when choosing the best rank', () => {
    const parsed = parseSerpResult(
      {
        items: [
          { type: 'organic', rank_group: null, rank_absolute: null, url: 'https://example.com/a' },
          { type: 'organic', rank_group: 4, rank_absolute: 9, url: 'https://example.com/b' },
        ],
      },
      'example.com',
    );

    // A result with no rank cannot be the best one.
    expect(parsed.rankGroup).toBe(4);
    expect(parsed.rankingUrl).toBe('https://example.com/b');
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   Provider timestamps
   ══════════════════════════════════════════════════════════════════════════ */

describe('parseProviderDatetime', () => {
  it('parses the format DataForSEO actually sends', () => {
    expect(parseProviderDatetime('2026-09-12 14:03:22 +00:00')?.toISOString()).toBe(
      '2026-09-12T14:03:22.000Z',
    );
  });

  it('honours a non-UTC offset rather than assuming UTC', () => {
    expect(parseProviderDatetime('2026-09-12 14:03:22 +05:30')?.toISOString()).toBe(
      '2026-09-12T08:33:22.000Z',
    );
  });

  it('assumes UTC when no offset is given', () => {
    expect(parseProviderDatetime('2026-09-12 14:03:22')?.toISOString()).toBe(
      '2026-09-12T14:03:22.000Z',
    );
  });

  it('returns null for absent or unparseable values', () => {
    expect(parseProviderDatetime(null)).toBeNull();
    expect(parseProviderDatetime(undefined)).toBeNull();
    expect(parseProviderDatetime('')).toBeNull();
    expect(parseProviderDatetime('yesterday')).toBeNull();
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   Payload trimming
   ══════════════════════════════════════════════════════════════════════════ */

describe('trimSerpPayload', () => {
  const result = resultOf(foundFixture);
  const trimmed = trimSerpPayload(result);

  it('keeps organic items only', () => {
    expect(trimmed.items.every((i) => i.type === 'organic')).toBe(true);
  });

  it('caps at 20 items', () => {
    expect(trimmed.items.length).toBeLessThanOrEqual(20);
  });

  it('drops the bulky fields', () => {
    for (const item of trimmed.items) {
      for (const field of ['description', 'breadcrumb', 'about_this_result', 'cache_url']) {
        expect(item, `kept ${field}`).not.toHaveProperty(field);
      }
    }
  });

  it('keeps the fields the UI reads', () => {
    expect(trimmed.items[0]).toMatchObject({
      rank_group: expect.any(Number),
      rank_absolute: expect.any(Number),
      domain: expect.any(String),
      url: expect.any(String),
    });
  });

  it('records which feature types were present, so the strip survives pruning', () => {
    // The blocks themselves are dropped, but the composition strip still needs
    // to know an AI Overview was there 30 days later.
    expect(trimmed.item_types).toContain('ai_overview');
    expect(trimmed.item_types).toContain('local_pack');
  });

  it('shrinks the payload substantially', () => {
    const before = JSON.stringify(result).length;
    const after = JSON.stringify(trimmed).length;
    expect(after).toBeLessThan(before / 2);
  });
});
