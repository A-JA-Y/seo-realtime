import type { DeviceType } from './schema';

/**
 * Seed constants for the first tracked property.
 *
 * `locationCode` values are placeholders in the sense that they MUST be
 * verified against `GET /v3/serp/google/locations` before the first paid SERP
 * run — DataForSEO revises them, and a stale code silently returns rankings
 * for the wrong geography. `pnpm tsx scripts/resolve-locations.ts` (M3) writes
 * the confirmed values back here. Until then the seed prints a warning.
 *
 * They live in the database (`keyword_targets.location_code`), never in
 * application code — this file is seed input, not a lookup table.
 */
export const LOCATIONS = {
  /** City-level: what a buyer in Noida actually sees. Local pack matters here. */
  noida: {
    locationCode: 1007742,
    locationName: 'Noida, Uttar Pradesh, India',
  },
  /** Country-level: more stable, better for broad trend lines. */
  india: {
    locationCode: 2356,
    locationName: 'India',
  },
} as const;

export const SEED_ORG = {
  name: 'Agency',
  slug: 'agency',
} as const;

export const SEED_PROPERTY = {
  name: 'Prestige Noida Sector 150',
  domain: 'prestigenoidasector150.com',
  /**
   * Must match Search Console exactly, trailing slash included for a
   * URL-prefix property. Confirm with `sites.list` (requirements.md §4) —
   * a mismatch reads as `403 User does not have sufficient permission for
   * site`, which looks like a permissions bug but is a string bug.
   */
  gscSiteUrl: 'https://prestigenoidasector150.com/',
  gscPropertyType: 'url_prefix',
  timezone: 'Asia/Kolkata',
} as const;

/**
 * The 13 tracked keywords. `primary` marks the money terms: they get a shorter
 * check interval and are the ones the overview's average-rank tile is built
 * from.
 */
export const SEED_KEYWORDS: ReadonlyArray<{ term: string; isPrimary: boolean }> = [
  { term: 'prestige sector 150 noida', isPrimary: true },
  { term: 'prestige noida sector 150', isPrimary: true },
  { term: 'prestige group noida sector 150', isPrimary: true },
  { term: 'prestige sector 150 noida price', isPrimary: true },
  { term: 'prestige sector 150 noida floor plan', isPrimary: false },
  { term: 'prestige sector 150 noida review', isPrimary: false },
  { term: 'prestige sector 150 noida possession', isPrimary: false },
  { term: 'prestige sector 150 noida location', isPrimary: false },
  { term: 'prestige sector 150 noida brochure', isPrimary: false },
  { term: 'prestige sector 150 noida amenities', isPrimary: false },
  { term: 'prestige apartments sector 150 noida', isPrimary: false },
  { term: 'new launch sector 150 noida', isPrimary: false },
  { term: 'luxury apartments sector 150 noida', isPrimary: false },
];

/**
 * Each keyword gets two targets. Tracking city and country side by side is
 * deliberate: the divergence between them is what explains "but I saw
 * position 4" to a client, and it costs one extra SERP call per check.
 *
 * Primary keywords check every 6 hours, secondary every 12 — see the cost
 * levers in requirements.md §13.
 */
export const SEED_TARGETS: ReadonlyArray<{
  location: keyof typeof LOCATIONS;
  device: DeviceType;
  intervalPrimaryMin: number;
  intervalSecondaryMin: number;
}> = [
  { location: 'noida', device: 'mobile', intervalPrimaryMin: 360, intervalSecondaryMin: 720 },
  { location: 'india', device: 'desktop', intervalPrimaryMin: 360, intervalSecondaryMin: 720 },
];
