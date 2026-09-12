import { z } from 'zod';

/**
 * DataForSEO SERP parsing — §6.
 *
 * The payload is already paid for, so everything useful is extracted from it in
 * one pass: our rank, our other ranking URLs, who is above us, and which SERP
 * blocks were present. §6 calls that core rather than optional, and it is what
 * turns a rank tracker into a competitive monitor.
 */

/* ══════════════════════════════════════════════════════════════════════════
   Response schemas — external data is validated, never trusted
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * One SERP element.
 *
 * `.loose()` is a deliberate exception to §16's no-passthrough rule, and the
 * only one: this object IS the raw payload we are asked to capture, DataForSEO
 * adds item fields without notice, and a strict schema would turn a harmless
 * addition into a total ingest outage. The fields we actually read are typed;
 * the rest ride along untouched into `serp_payloads`.
 */
export const serpItemSchema = z
  .object({
    type: z.string(),
    rank_group: z.number().int().nullable().optional(),
    rank_absolute: z.number().int().nullable().optional(),
    domain: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
  })
  .loose();

export type SerpItem = z.infer<typeof serpItemSchema>;

export const serpResultSchema = z.object({
  keyword: z.string().nullable().optional(),
  location_code: z.number().nullable().optional(),
  language_code: z.string().nullable().optional(),
  /** Provider's own timestamp for the SERP, e.g. "2026-09-12 14:00:00 +00:00". */
  datetime: z.string().nullable().optional(),
  se_results_count: z.union([z.number(), z.string()]).nullable().optional(),
  items_count: z.number().nullable().optional(),
  items: z.array(serpItemSchema).nullable().optional(),
});

export const serpTaskSchema = z.object({
  id: z.string().nullable().optional(),
  status_code: z.number(),
  status_message: z.string().nullable().optional(),
  cost: z.number().nullable().optional(),
  /** Echo of the request, including the `tag` that carries our target id. */
  data: z.looseObject({ tag: z.string().nullable().optional() }).nullable().optional(),
  result: z.array(serpResultSchema).nullable().optional(),
});

export const serpEnvelopeSchema = z.object({
  status_code: z.number(),
  status_message: z.string().nullable().optional(),
  cost: z.number().nullable().optional(),
  tasks: z.array(serpTaskSchema).nullable().optional(),
});

export type SerpEnvelope = z.infer<typeof serpEnvelopeSchema>;
export type SerpTask = z.infer<typeof serpTaskSchema>;

/* ══════════════════════════════════════════════════════════════════════════
   Domain matching
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Extract the hostname from a SERP result URL, lowercased and without `www.`.
 *
 * Returns null rather than throwing: one malformed URL in a hundred results
 * must not cost the whole check.
 */
export function hostnameOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.startsWith('www.') ? host.slice(4) : host;
  } catch {
    return null;
  }
}

/**
 * Is this result ours?
 *
 * §6: "match on registrable hostname, ignoring www. and scheme — NOT full-URL
 * equality." Full-URL equality would miss every page except the homepage, which
 * is the opposite of what a rank tracker needs.
 *
 * Subdomains count. An agency tracking `example.com` wants to know when
 * `blog.example.com` outranks it, and treating that as a competitor would put
 * the client's own site in their competitor table.
 *
 * The leading dot in the subdomain test is load-bearing: without it,
 * `notexample.com` matches `example.com`, and a competitor with a similar name
 * would be recorded as us — a rank that looks real and belongs to someone else.
 */
export function isOwnDomain(url: string | null | undefined, propertyDomain: string): boolean {
  const host = hostnameOf(url);
  if (!host) return false;

  const own = propertyDomain.toLowerCase().replace(/^www\./, '').replace(/\/+$/, '');
  return host === own || host.endsWith(`.${own}`);
}

/* ══════════════════════════════════════════════════════════════════════════
   Parse result
   ══════════════════════════════════════════════════════════════════════════ */

export interface RankingUrl {
  rank_group: number | null;
  url: string;
}

export interface CompetingDomain {
  rank_group: number | null;
  domain: string | null;
  url: string | null;
  title: string | null;
}

/**
 * Which non-organic blocks were on the page.
 *
 * This is the other half of the reconciliation story. A rank that held steady
 * while an AI Overview appeared above it is a visibility LOSS, and without this
 * the chart would show a flat line and call it stable.
 */
export interface SerpFeatures {
  ai_overview: boolean;
  local_pack: boolean;
  images: boolean;
  people_also_ask: boolean;
  video: boolean;
  top_stories: boolean;
  paid_count: number;
}

export interface ParsedSerp {
  /** False means absent from the fetched depth. Ranks stay NULL — never 100. */
  found: boolean;
  /** Organic-only position: "which blue link am I". */
  rankGroup: number | null;
  /** All-elements position: how far down the page. Reconciles with GSC. */
  rankAbsolute: number | null;
  rankingUrl: string | null;
  allRankingUrls: RankingUrl[];
  competingDomains: CompetingDomain[];
  serpFeatures: SerpFeatures;
  organicResultCount: number;
  /** The provider's own timestamp for this SERP, when it supplied one. */
  checkedAt: Date | null;
  keyword: string | null;
}

const COMPETITOR_LIMIT = 10;

/**
 * Parse one SERP result into the shape `serp_checks` stores.
 *
 * Takes the `result[0]` object rather than the whole envelope, so the same
 * function serves the queued webhook and the live "check now" call — two
 * parsers would be two definitions of what rank means.
 */
export function parseSerpResult(
  result: z.infer<typeof serpResultSchema>,
  propertyDomain: string,
): ParsedSerp {
  const items = result.items ?? [];
  const organic = items.filter((item) => item.type === 'organic');

  const mine = organic.filter((item) => isOwnDomain(item.url, propertyDomain));

  /*
   * §6 rule 8: if more than one of our URLs ranks, the BEST rank_group is the
   * position and the full set is stored. Nulls sort last — a result with no
   * rank cannot be the best one.
   */
  const best = [...mine].sort(
    (a, b) => (a.rank_group ?? Number.MAX_SAFE_INTEGER) - (b.rank_group ?? Number.MAX_SAFE_INTEGER),
  )[0];

  const mineSet = new Set(mine);

  return {
    found: mine.length > 0,
    // Domain rule 5: absent means NULL, never a sentinel. Writing 100 here
    // would corrupt every average computed downstream.
    rankGroup: best?.rank_group ?? null,
    rankAbsolute: best?.rank_absolute ?? null,
    rankingUrl: best?.url ?? null,

    allRankingUrls: mine
      .filter((item): item is SerpItem & { url: string } => typeof item.url === 'string')
      .map((item) => ({ rank_group: item.rank_group ?? null, url: item.url })),

    competingDomains: organic
      .filter((item) => !mineSet.has(item))
      .slice(0, COMPETITOR_LIMIT)
      .map((item) => ({
        rank_group: item.rank_group ?? null,
        domain: item.domain ?? hostnameOf(item.url),
        url: item.url ?? null,
        title: item.title ?? null,
      })),

    serpFeatures: {
      ai_overview: items.some((i) => i.type === 'ai_overview'),
      local_pack: items.some((i) => i.type === 'local_pack'),
      images: items.some((i) => i.type === 'images'),
      people_also_ask: items.some((i) => i.type === 'people_also_ask'),
      video: items.some((i) => i.type === 'video'),
      top_stories: items.some((i) => i.type === 'top_stories'),
      paid_count: items.filter((i) => i.type === 'paid').length,
    },

    organicResultCount: organic.length,
    checkedAt: parseProviderDatetime(result.datetime),
    keyword: result.keyword ?? null,
  };
}

/**
 * Parse DataForSEO's `datetime`, e.g. "2026-09-12 14:03:22 +00:00".
 *
 * The provider's timestamp is preferred over our receipt time because it is the
 * natural key: `UNIQUE (keyword_target_id, checked_at)`. A pingback delivered
 * twice — which DataForSEO will do if we ever fail to return 200 — must
 * collapse onto the same row rather than inserting a second check for the same
 * SERP. Stamping `now()` would make every redelivery a new data point.
 */
export function parseProviderDatetime(value: string | null | undefined): Date | null {
  if (!value) return null;

  // "YYYY-MM-DD HH:MM:SS +00:00" is not a format Date.parse handles portably.
  const normalised = value.trim().replace(' ', 'T').replace(/ (?=[+-]\d{2}:\d{2}$)/, '');
  const parsed = new Date(/[+-]\d{2}:\d{2}$|Z$/.test(normalised) ? normalised : `${normalised}Z`);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/* ══════════════════════════════════════════════════════════════════════════
   Payload trimming
   ══════════════════════════════════════════════════════════════════════════ */

/** Fields that dominate payload size and that nothing in this app reads. */
const BULKY_FIELDS = [
  'description',
  'extended_snippet',
  'breadcrumb',
  'about_this_result',
  'related_search_url',
  'highlighted',
  'links',
  'faq',
  'extended_people_also_search',
  'images',
  'rating',
  'price',
  'rectangle',
  'main_domain',
  'relative_url',
  'cache_url',
  'is_image',
  'is_video',
  'is_featured_snippet',
  'is_malicious',
  'is_web_story',
  'amp_version',
  'timestamp',
  'pre_snippet',
  'website_name',
] as const;

/** §6: "organic items only, top 20, dropping the bulky fields". */
const PAYLOAD_ITEM_LIMIT = 20;

export interface TrimmedPayload {
  keyword: string | null;
  datetime: string | null;
  location_code: number | null;
  language_code: string | null;
  items_count: number | null;
  organic_result_count: number;
  /** Feature types present, so the composition strip survives payload pruning. */
  item_types: string[];
  items: Array<Record<string, unknown>>;
}

/**
 * Reduce a result to what is worth keeping for 30 days.
 *
 * Neon's free tier is 0.5 GB per project and a full advanced SERP payload is
 * tens of kilobytes. Storing them whole outgrows the tier within a year, which
 * is why §6 puts payloads in their own table with their own retention — and why
 * only the top 20 organic items survive.
 *
 * `item_types` is kept even though the items themselves are dropped: the SERP
 * composition strip needs to know an AI Overview was present long after the
 * block itself has been pruned.
 */
export function trimSerpPayload(result: z.infer<typeof serpResultSchema>): TrimmedPayload {
  const items = result.items ?? [];
  const organic = items.filter((item) => item.type === 'organic');

  return {
    keyword: result.keyword ?? null,
    datetime: result.datetime ?? null,
    location_code: result.location_code ?? null,
    language_code: result.language_code ?? null,
    items_count: result.items_count ?? null,
    organic_result_count: organic.length,
    item_types: [...new Set(items.map((item) => item.type))],
    items: organic.slice(0, PAYLOAD_ITEM_LIMIT).map((item) => {
      const kept: Record<string, unknown> = { ...item };
      for (const field of BULKY_FIELDS) delete kept[field];
      return kept;
    }),
  };
}
