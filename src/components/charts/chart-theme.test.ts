import { describe, expect, it } from 'vitest';

import { rankDomain, rankTicks, SERIES } from './chart-theme';

describe('rankDomain', () => {
  /*
   * The domain always starts at 1. An inverted rank axis whose top is "3"
   * silently rescales every chart to its own best result, so two keywords side
   * by side look equally good.
   */
  it('always starts at position 1', () => {
    expect(rankDomain([3, 4, 5])[0]).toBe(1);
    expect(rankDomain([80, 95])[0]).toBe(1);
  });

  it('leaves the worst value room rather than clipping it', () => {
    const [, max] = rankDomain([1, 12, 27]);
    expect(max).toBeGreaterThanOrEqual(27);
  });

  it('ignores nulls instead of treating them as zero', () => {
    expect(rankDomain([null, 8, null])).toEqual(rankDomain([8]));
  });

  it('survives a series that is entirely missing', () => {
    expect(rankDomain([null, null])).toEqual([1, 10]);
    expect(rankDomain([])).toEqual([1, 10]);
  });
});

describe('rankTicks', () => {
  it('always labels position 1, the number everyone is looking for', () => {
    expect(rankTicks([1, 30])[0]).toBe(1);
    expect(rankTicks([1, 5])[0]).toBe(1);
    expect(rankTicks([1, 100])[0]).toBe(1);
  });

  it('labels the bottom of the domain', () => {
    expect(rankTicks([1, 30]).at(-1)).toBe(30);
    expect(rankTicks([1, 45]).at(-1)).toBe(45);
  });

  it('stays inside the domain', () => {
    for (const max of [5, 10, 25, 30, 55, 100]) {
      const ticks = rankTicks([1, max]);
      expect(Math.min(...ticks)).toBeGreaterThanOrEqual(1);
      expect(Math.max(...ticks)).toBeLessThanOrEqual(max);
    }
  });

  it('never repeats a tick', () => {
    for (const max of [5, 10, 20, 25, 30, 40, 60, 100]) {
      const ticks = rankTicks([1, max]);
      expect(new Set(ticks).size).toBe(ticks.length);
    }
  });

  it('keeps a readable number of labels', () => {
    for (const max of [5, 10, 25, 30, 60, 100]) {
      expect(rankTicks([1, max]).length).toBeLessThanOrEqual(9);
    }
  });
});

describe('SERIES', () => {
  /*
   * Clients print these charts. Colour alone would leave three grey lines, so
   * every series carries a distinct stroke pattern as well — and the three
   * patterns have to actually differ.
   */
  it('gives each series its own stroke pattern, not just its own colour', () => {
    const dashes = [SERIES.rankGroup.dash, SERIES.rankAbsolute.dash, SERIES.gsc.dash];
    expect(new Set(dashes).size).toBe(3);
  });

  it('gives each series its own colour', () => {
    const colors = [SERIES.rankGroup.color, SERIES.rankAbsolute.color, SERIES.gsc.color];
    expect(new Set(colors).size).toBe(3);
  });

  // Acceptance criterion 7: every position number is labelled with its source.
  it('names the source of every series', () => {
    expect(SERIES.rankGroup.source).toMatch(/DataForSEO/);
    expect(SERIES.rankAbsolute.source).toMatch(/DataForSEO/);
    expect(SERIES.gsc.source).toMatch(/Search Console/);
  });
});
