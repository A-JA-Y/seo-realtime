import { describe, expect, it } from 'vitest';

import type { GscSeriesPoint } from '@/server/ingest/gsc-series';
import type { SerpFeatures } from '@/server/ingest/serp-parse';
import {
  confidenceOf,
  describeFeatures,
  explainReconciliation,
  joinPhrases,
  type GscSide,
  type SerpSide,
} from './reconciliation';

const features = (overrides: Partial<SerpFeatures> = {}): SerpFeatures => ({
  ai_overview: false,
  local_pack: false,
  images: false,
  people_also_ask: false,
  video: false,
  top_stories: false,
  paid_count: 0,
  ...overrides,
});

const gscSide = (overrides: Partial<GscSide> = {}): GscSide => ({
  source: 'Search Console average position',
  date: '2026-09-08',
  position: 13.4,
  impressions: 88,
  clicks: 3,
  state: 'final',
  isProvisional: false,
  confidence: 'normal',
  ...overrides,
});

const serpSide = (overrides: Partial<SerpSide> = {}): SerpSide => ({
  source: 'Live rank check',
  keywordTargetId: 't1',
  locationName: 'Noida, Uttar Pradesh, India',
  device: 'mobile',
  checkedAt: new Date('2026-09-08T12:00:00Z'),
  found: true,
  rankGroup: 7,
  rankAbsolute: 13,
  furnitureGap: 6,
  serpFeatures: features({ local_pack: true, images: true, paid_count: 1 }),
  rankingUrl: 'https://example.com/',
  hoursFromDate: 0,
  ...overrides,
});

const text = (lines: string[]) => lines.join(' ');

describe('describeFeatures', () => {
  it('names the blocks present, and nothing else', () => {
    expect(describeFeatures(features({ ai_overview: true, local_pack: true }))).toEqual([
      'an AI Overview',
      'a local pack',
    ]);
  });

  it('counts ads rather than naming them', () => {
    expect(describeFeatures(features({ paid_count: 1 }))).toEqual(['one ad']);
    expect(describeFeatures(features({ paid_count: 3 }))).toEqual(['3 ads']);
  });

  it('returns nothing for a bare SERP', () => {
    expect(describeFeatures(features())).toEqual([]);
    expect(describeFeatures(null)).toEqual([]);
  });
});

describe('joinPhrases', () => {
  it('reads like prose, not a list', () => {
    expect(joinPhrases(['a'])).toBe('a');
    expect(joinPhrases(['a', 'b'])).toBe('a and b');
    expect(joinPhrases(['a', 'b', 'c'])).toBe('a, b and c');
    expect(joinPhrases([])).toBe('');
  });
});

describe('confidenceOf', () => {
  it('flags fewer than 3 impressions', () => {
    expect(confidenceOf(0)).toBe('low');
    expect(confidenceOf(2)).toBe('low');
  });

  it('does not flag exactly 3', () => {
    expect(confidenceOf(3)).toBe('normal');
  });

  it('distinguishes "no data" from "measured zero"', () => {
    expect(confidenceOf(null)).toBe('none');
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   The explanation — acceptance criterion 5
   ══════════════════════════════════════════════════════════════════════════ */

describe('explainReconciliation', () => {
  it('names the SPECIFIC features responsible for the gap', () => {
    // "...naming the specific SERP features responsible."
    const out = text(explainReconciliation(gscSide(), [serpSide()]));

    expect(out).toContain('a local pack');
    expect(out).toContain('an images block');
    expect(out).toContain('one ad');
    expect(out).toContain('6-place gap');
  });

  it('states both positions, and says which is which', () => {
    const out = text(explainReconciliation(gscSide(), [serpSide()]));

    expect(out).toContain('13.4');
    expect(out).toContain('organic result **#7**');
    expect(out).toContain('**#13** counting every element');
  });

  it('explains that Search Console counts the blocks and a human does not', () => {
    // This is the sentence that stops the support ticket recurring.
    const out = text(explainReconciliation(gscSide(), [serpSide()]));
    expect(out).toMatch(/Search Console counts those; a human counting blue links does not/);
  });

  it('names the location and device the check came from', () => {
    // A pinned check is not a national average, and saying so is the second
    // half of the explanation.
    const out = text(explainReconciliation(gscSide(), [serpSide()]));
    expect(out).toContain('Noida, Uttar Pradesh, India on mobile');
  });

  it('says the two AGREE when rank_absolute lines up with the average', () => {
    const out = text(
      explainReconciliation(gscSide({ position: 13.2 }), [serpSide({ rankAbsolute: 13 })]),
    );
    expect(out).toMatch(/lines up with the Search Console average/);
  });

  it('attributes a remaining difference to the averaging, not to the counting', () => {
    const out = text(
      explainReconciliation(gscSide({ position: 24.8 }), [serpSide({ rankAbsolute: 13 })]),
    );

    expect(out).toMatch(/differ by about 11\.8 places/);
    expect(out).toMatch(/averages every device, location and query variant/);
  });

  it('handles a gap of zero without claiming one', () => {
    const out = text(
      explainReconciliation(gscSide(), [
        serpSide({ rankGroup: 3, rankAbsolute: 3, furnitureGap: 0, serpFeatures: features() }),
      ]),
    );

    expect(out).not.toMatch(/0-place gap/);
    expect(out).toContain('organic result **#3**');
  });

  it('says features below you cost you nothing', () => {
    const out = text(
      explainReconciliation(gscSide(), [
        serpSide({
          rankGroup: 1,
          rankAbsolute: 1,
          furnitureGap: 0,
          serpFeatures: features({ people_also_ask: true }),
        }),
      ]),
    );

    expect(out).toMatch(/below you — so they cost you nothing/);
  });

  /* ── The awkward cases ────────────────────────────────────────────────── */

  it('explains a not-found check WITHOUT inventing position 100', () => {
    const out = text(
      explainReconciliation(gscSide(), [
        serpSide({ found: false, rankGroup: null, rankAbsolute: null, furnitureGap: null }),
      ]),
    );

    expect(out).toMatch(/did not find the domain in the top 100/);
    expect(out).toMatch(/never as position 100/);
    expect(out).not.toMatch(/#100/);
  });

  it('explains an absent Search Console figure as "no impressions", not "lost"', () => {
    const out = text(
      explainReconciliation(gscSide({ position: null, impressions: null, state: 'none' }), [
        serpSide(),
      ]),
    );

    expect(out).toMatch(/reported nothing/);
    expect(out).toMatch(/not a lost ranking/);
  });

  it('explains a zero-impression day distinctly from an absent one', () => {
    const out = text(
      explainReconciliation(gscSide({ position: null, impressions: 0, state: 'final' }), [
        serpSide(),
      ]),
    );

    expect(out).toMatch(/0 impressions .* but no position/);
    expect(out).toMatch(/nobody saw the result/);
  });

  it('warns that a low-impression average is noise, and says it is excluded from alerts', () => {
    const out = text(
      explainReconciliation(
        gscSide({ position: 6, impressions: 1, confidence: 'low' }),
        [serpSide()],
      ),
    );

    expect(out).toMatch(/fewer than 3 impressions/);
    expect(out).toMatch(/excluded from alerts/);
  });

  it('says a provisional figure is still moving', () => {
    const out = text(
      explainReconciliation(
        gscSide({ state: 'hourly', isProvisional: true }),
        [serpSide()],
      ),
    );

    expect(out).toMatch(/still provisional/);
    expect(out).toMatch(/partial hourly data/);
  });

  it('says so plainly when no check has run near the date', () => {
    const out = text(
      explainReconciliation(gscSide(), [
        serpSide({ checkedAt: null, hoursFromDate: null, rankGroup: null, rankAbsolute: null }),
      ]),
    );

    expect(out).toMatch(/No rank check has run near this date/);
  });

  it('reports each pinned location separately — they are different measurements', () => {
    const out = text(
      explainReconciliation(gscSide(), [
        serpSide({ locationName: 'Noida, Uttar Pradesh, India', device: 'mobile', rankGroup: 4 }),
        serpSide({
          keywordTargetId: 't2',
          locationName: 'India',
          device: 'desktop',
          rankGroup: 12,
          rankAbsolute: 16,
          furnitureGap: 4,
        }),
      ]),
    );

    expect(out).toContain('Noida, Uttar Pradesh, India on mobile');
    expect(out).toContain('India on desktop');

    // The divergence between pinned locations is its own signal — it is what
    // explains "but I saw position 4" to a client.
    expect(out).toMatch(/locations disagree by 8 places/);
    expect(out).toMatch(/Search Console blends both into one number/);
  });

  it('does not claim a spread when the locations agree', () => {
    const out = text(
      explainReconciliation(gscSide(), [
        serpSide({ rankGroup: 7 }),
        serpSide({ keywordTargetId: 't2', locationName: 'India', device: 'desktop', rankGroup: 7 }),
      ]),
    );

    expect(out).not.toMatch(/locations disagree/);
  });

  it('never averages the two sources together', () => {
    // Domain rule 1. The mean of 13.4 and 7 is 10.2 — a number that measures
    // nothing and must never appear.
    const out = text(explainReconciliation(gscSide(), [serpSide()]));
    expect(out).not.toContain('10.2');
  });

  it('produces something readable for every combination of missing data', () => {
    const cases: Array<[GscSide, SerpSide[]]> = [
      [gscSide({ position: null, impressions: null, state: 'none' }), []],
      [gscSide(), []],
      [gscSide({ position: null, impressions: 0 }), [serpSide({ found: false })]],
      [gscSide({ confidence: 'low', impressions: 1 }), [serpSide({ serpFeatures: null })]],
      [gscSide(), [serpSide({ rankAbsolute: null, furnitureGap: null })]],
    ];

    for (const [gsc, targets] of cases) {
      const lines = explainReconciliation(gsc, targets);
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.every((l) => l.trim().length > 0)).toBe(true);
      // No unfilled template holes.
      expect(text(lines)).not.toMatch(/undefined|null|NaN|\[object/);
    }
  });
});
