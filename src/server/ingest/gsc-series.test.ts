import { describe, expect, it } from 'vitest';

import {
  GscSeriesDataError,
  LOW_CONFIDENCE_IMPRESSIONS,
  aggregateHourlyRows,
  isAlertEligible,
  pacificHourLabelsInDay,
  resolveGscSeries,
  seriesWindow,
  toNumber,
  type GscSnapshotRow,
} from './gsc-series';

/** Build a row the way the driver hands it over: numerics as STRINGS. */
function daily(
  date: string,
  state: 'final' | 'fresh',
  fields: { clicks?: number; impressions: number; position?: number | null },
): GscSnapshotRow {
  return {
    gscDate: date,
    gscHour: null,
    dataState: state,
    clicks: fields.clicks ?? 0,
    impressions: fields.impressions,
    ctr: '0',
    position:
      fields.position === undefined || fields.position === null ? null : fields.position.toFixed(2),
  };
}

function hourly(
  date: string,
  hour: number,
  fields: { clicks?: number; impressions: number; position?: number | null },
): GscSnapshotRow {
  return {
    gscDate: date,
    gscHour: hour,
    dataState: 'hourly',
    clicks: fields.clicks ?? 0,
    impressions: fields.impressions,
    ctr: '0',
    position:
      fields.position === undefined || fields.position === null ? null : fields.position.toFixed(2),
  };
}

const one = (rows: GscSnapshotRow[], date: string) =>
  resolveGscSeries(rows, { from: date, to: date })[0]!;

/* ══════════════════════════════════════════════════════════════════════════
   Numeric boundary
   ══════════════════════════════════════════════════════════════════════════ */

describe('toNumber', () => {
  it('parses the string form Postgres numeric actually arrives as', () => {
    // Verified against a live database: `position` comes back as "13.40", and
    // reading it without parsing makes `position + 1` yield "13.401".
    expect(toNumber('13.40', 'position')).toBe(13.4);
    expect(toNumber('0.034090', 'ctr')).toBe(0.03409);
  });

  it('passes numbers through', () => {
    expect(toNumber(7.8, 'position')).toBe(7.8);
    expect(toNumber(0, 'x')).toBe(0);
  });

  it('maps null and undefined to null', () => {
    expect(toNumber(null, 'position')).toBeNull();
    expect(toNumber(undefined, 'position')).toBeNull();
  });

  it('THROWS rather than returning NaN', () => {
    // A NaN escaping here poisons every average downstream and renders as a
    // blank chart with no explanation.
    expect(() => toNumber('', 'position')).toThrow(GscSeriesDataError);
    expect(() => toNumber('n/a', 'position')).toThrow(/not numeric/);
    expect(() => toNumber(Number.NaN, 'position')).toThrow(/not finite/);
    expect(() => toNumber(Number.POSITIVE_INFINITY, 'position')).toThrow(/not finite/);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   Precedence
   ══════════════════════════════════════════════════════════════════════════ */

describe('precedence: final > fresh > hourly', () => {
  const date = '2026-09-08';

  it('final beats fresh and hourly', () => {
    const point = one(
      [
        hourly(date, 9, { impressions: 10, position: 30 }),
        daily(date, 'fresh', { impressions: 50, position: 20 }),
        daily(date, 'final', { impressions: 88, position: 13.4 }),
      ],
      date,
    );

    expect(point.source).toBe('final');
    expect(point.position).toBe(13.4);
    expect(point.impressions).toBe(88);
    expect(point.isProvisional).toBe(false);
  });

  it('fresh beats hourly when there is no final', () => {
    const point = one(
      [
        hourly(date, 9, { impressions: 10, position: 30 }),
        daily(date, 'fresh', { impressions: 50, position: 20 }),
      ],
      date,
    );

    expect(point.source).toBe('fresh');
    expect(point.position).toBe(20);
    expect(point.isProvisional).toBe(true);
  });

  it('falls back to the hourly aggregate when neither daily state exists', () => {
    const point = one([hourly(date, 9, { impressions: 10, position: 30 })], date);
    expect(point.source).toBe('hourly');
    expect(point.position).toBe(30);
  });

  it('resolves by STATE, not by which row happens to have a position', () => {
    // A final row that retracted the position still wins. Falling back to the
    // hourly reading would resurrect a number Google has since withdrawn.
    const point = one(
      [
        hourly(date, 9, { impressions: 12, position: 12.5 }),
        daily(date, 'final', { impressions: 0, position: null }),
      ],
      date,
    );

    expect(point.source).toBe('final');
    expect(point.position).toBeNull();
    expect(point.provisional[0]).toMatchObject({ source: 'hourly', position: 12.5 });
  });

  it('keeps the superseded readings so a revision stays visible', () => {
    // Acceptance criterion 10: the provisional value must remain queryable.
    const point = one(
      [
        hourly(date, 9, { impressions: 4, position: 35 }),
        daily(date, 'fresh', { impressions: 40, position: 21 }),
        daily(date, 'final', { impressions: 88, position: 13.4 }),
      ],
      date,
    );

    expect(point.position).toBe(13.4);
    expect(point.provisional.map((c) => c.source)).toEqual(['fresh', 'hourly']);
    expect(point.provisional.map((c) => c.position)).toEqual([21, 35]);
  });

  it('reports no provisional readings when only a final row is held', () => {
    const point = one([daily(date, 'final', { impressions: 88, position: 13.4 })], date);
    expect(point.provisional).toEqual([]);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   Impression-weighted aggregation
   ══════════════════════════════════════════════════════════════════════════ */

describe('impression-weighted hourly aggregation', () => {
  it('weights by impressions, not by hour', () => {
    // The unweighted mean here is 11.5. The honest answer is ~19.92: almost
    // everyone who saw this keyword saw it at position 20.
    const result = aggregateHourlyRows([
      hourly('2026-09-11', 9, { impressions: 1, position: 3 }),
      hourly('2026-09-11', 10, { impressions: 200, position: 20 }),
    ]);

    expect(result.position).toBe(19.92);
    expect(result.impressions).toBe(201);
    expect(result.positionImpressions).toBe(201);
  });

  it('excludes zero-impression hours from BOTH numerator and denominator', () => {
    // Including them in the denominator would drag the average toward zero in
    // proportion to how many hours were quiet — a wrong number that reads as
    // an improvement on an inverted axis.
    const result = aggregateHourlyRows([
      hourly('2026-09-11', 8, { impressions: 0, position: null }),
      hourly('2026-09-11', 9, { impressions: 10, position: 10 }),
      hourly('2026-09-11', 10, { impressions: 10, position: 20 }),
      hourly('2026-09-11', 11, { impressions: 0, position: null }),
    ]);

    expect(result.position).toBe(15);
    expect(result.positionImpressions).toBe(20);
    expect(result.impressions).toBe(20);
  });

  it('returns a NULL position when every hour had zero impressions', () => {
    const result = aggregateHourlyRows([
      hourly('2026-09-11', 8, { impressions: 0, position: null }),
      hourly('2026-09-11', 9, { impressions: 0, position: null }),
    ]);

    expect(result.position).toBeNull();
    expect(result.impressions).toBe(0);
    expect(result.ctr).toBeNull();
    expect(result.positionImpressions).toBe(0);
  });

  it('sums clicks and impressions across hours', () => {
    const result = aggregateHourlyRows([
      hourly('2026-09-11', 9, { clicks: 1, impressions: 12, position: 9.5 }),
      hourly('2026-09-11', 13, { clicks: 2, impressions: 31, position: 7.8 }),
    ]);

    expect(result.clicks).toBe(3);
    expect(result.impressions).toBe(43);
  });

  it('recomputes CTR as clicks/impressions, never as a mean of hourly ratios', () => {
    // Mean of ratios: (0 + 0 + 1) / 3 = 33.3%. Ratio of sums: 1/201 = 0.5%.
    const result = aggregateHourlyRows([
      hourly('2026-09-11', 9, { clicks: 0, impressions: 100, position: 10 }),
      hourly('2026-09-11', 10, { clicks: 0, impressions: 100, position: 10 }),
      hourly('2026-09-11', 11, { clicks: 1, impressions: 1, position: 10 }),
    ]);

    expect(result.ctr).toBeCloseTo(1 / 201, 6);
    expect(result.ctr).not.toBeCloseTo(0.3333, 3);
  });

  it('is order-independent', () => {
    const rows = [
      hourly('2026-09-11', 9, { impressions: 7, position: 12.34 }),
      hourly('2026-09-11', 13, { impressions: 3, position: 5.67 }),
      hourly('2026-09-11', 21, { impressions: 11, position: 19.01 }),
    ];

    const forward = aggregateHourlyRows(rows);
    const reversed = aggregateHourlyRows([...rows].reverse());
    expect(forward).toEqual(reversed);
  });

  it('rounds to the 2dp grid the column stores', () => {
    const result = aggregateHourlyRows([
      hourly('2026-09-11', 9, { impressions: 3, position: 10 }),
      hourly('2026-09-11', 10, { impressions: 3, position: 11 }),
      hourly('2026-09-11', 11, { impressions: 3, position: 13 }),
    ]);

    expect(result.position).toBe(11.33);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   Nulls, gaps and the sentinel rule
   ══════════════════════════════════════════════════════════════════════════ */

describe('nulls and gaps', () => {
  it('returns a DENSE series — every date appears', () => {
    const points = resolveGscSeries([daily('2026-09-10', 'final', { impressions: 5, position: 8 })], {
      from: '2026-09-08',
      to: '2026-09-12',
    });

    expect(points.map((p) => p.date)).toEqual([
      '2026-09-08',
      '2026-09-09',
      '2026-09-10',
      '2026-09-11',
      '2026-09-12',
    ]);
  });

  it('marks a date we hold nothing for as source "none" with null metrics', () => {
    // Acceptance criterion 3: the chart must draw a gap, never a zero. On an
    // inverted rank axis a zero renders ABOVE position 1 — better than first.
    const point = one([], '2026-09-09');

    expect(point).toMatchObject({
      source: 'none',
      position: null,
      clicks: null,
      impressions: null,
      ctr: null,
      positionImpressions: 0,
      hourCoverage: null,
    });
  });

  it('distinguishes "we hold nothing" from "we measured zero"', () => {
    const held = one([daily('2026-09-09', 'final', { impressions: 0, position: null })], '2026-09-09');
    const absent = one([], '2026-09-09');

    expect(held.impressions).toBe(0);
    expect(held.source).toBe('final');
    expect(absent.impressions).toBeNull();
    expect(absent.source).toBe('none');
  });

  it('never substitutes a number for a missing position', () => {
    // Domain rule 5's principle: no sentinel, ever.
    const points = resolveGscSeries(
      [
        daily('2026-09-08', 'final', { impressions: 0, position: null }),
        daily('2026-09-10', 'final', { impressions: 88, position: 13.4 }),
      ],
      { from: '2026-09-08', to: '2026-09-10' },
    );

    expect(points.map((p) => p.position)).toEqual([null, null, 13.4]);
    expect(points.every((p) => p.position !== 0 && p.position !== 100)).toBe(true);
  });

  it('forces position to null when a row has no impressions, whatever is stored', () => {
    // Defence in depth: the CHECK constraint makes this unstorable, and the
    // read path still does not trust it.
    const point = one([daily('2026-09-09', 'final', { impressions: 0, position: 6 })], '2026-09-09');

    expect(point.position).toBeNull();
    expect(point.positionImpressions).toBe(0);
  });

  it('reports CTR of 0 for a real measured zero, and null for no impressions', () => {
    const measured = one(
      [daily('2026-09-09', 'final', { clicks: 0, impressions: 40, position: 12 })],
      '2026-09-09',
    );
    const nothing = one([daily('2026-09-09', 'final', { impressions: 0 })], '2026-09-09');

    expect(measured.ctr).toBe(0);
    expect(nothing.ctr).toBeNull();
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   Low-confidence suppression (domain rule 6)
   ══════════════════════════════════════════════════════════════════════════ */

describe('low-confidence suppression', () => {
  it('flags fewer than 3 impressions', () => {
    for (const impressions of [0, 1, 2]) {
      const point = one(
        [daily('2026-09-09', 'final', { impressions, position: impressions ? 6 : null })],
        '2026-09-09',
      );
      expect(point.isLowConfidence, `${impressions} impressions`).toBe(true);
    }
  });

  it('does NOT flag exactly 3 — "fewer than 3" excludes 3', () => {
    const point = one([daily('2026-09-09', 'final', { impressions: 3, position: 6 })], '2026-09-09');
    expect(point.isLowConfidence).toBe(false);
    expect(LOW_CONFIDENCE_IMPRESSIONS).toBe(3);
  });

  it('keys confidence on the impressions BEHIND the position, not the day total', () => {
    // 100 impressions across the day, but only 2 of them produced a position.
    // Trusting the day total would call this high-confidence noise.
    const point = one(
      [
        hourly('2026-09-09', 8, { impressions: 98, position: null }),
        hourly('2026-09-09', 9, { impressions: 2, position: 4 }),
      ],
      '2026-09-09',
    );

    expect(point.impressions).toBe(100);
    expect(point.positionImpressions).toBe(2);
    expect(point.isLowConfidence).toBe(true);
  });

  it('stores the row but keeps it out of alerts', () => {
    // "Store it; do not trust it."
    const noisy = one([daily('2026-09-09', 'final', { impressions: 1, position: 6 })], '2026-09-09');

    expect(noisy.position).toBe(6);
    expect(isAlertEligible(noisy)).toBe(false);
  });

  it('treats a missing date as ineligible for alerts', () => {
    expect(isAlertEligible(one([], '2026-09-09'))).toBe(false);
  });

  it('allows a well-evidenced position through', () => {
    expect(isAlertEligible(one([daily('2026-09-09', 'final', { impressions: 88, position: 13.4 })], '2026-09-09'))).toBe(
      true,
    );
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   Hour coverage and DST
   ══════════════════════════════════════════════════════════════════════════ */

describe('pacificHourLabelsInDay', () => {
  it('counts 24 on an ordinary day', () => {
    expect(pacificHourLabelsInDay('2026-06-15')).toBe(24);
  });

  it('counts 23 on the spring-forward day — 02:00 never happens', () => {
    expect(pacificHourLabelsInDay('2026-03-08')).toBe(23);
  });

  it('counts 24 on the 25-hour fall-back day, because gsc_hour is a LABEL', () => {
    // The trap: 2026-11-01 is 25 hours long, but gsc_hour is a SMALLINT 0-23.
    // Hour 1 happens twice and shares one label. Treating the day as 25 hours
    // would make every fall-back day render as permanently incomplete.
    expect(pacificHourLabelsInDay('2026-11-01')).toBe(24);
  });
});

describe('hour coverage', () => {
  it('reports coverage only for an hourly-derived point', () => {
    const point = one(
      [hourly('2026-09-11', 9, { impressions: 4, position: 18.25 }), hourly('2026-09-11', 13, { impressions: 12, position: 9.5 })],
      '2026-09-11',
    );

    expect(point.hourCoverage).toEqual({ hoursWithData: 2, hoursInDay: 24 });
  });

  it('reports no coverage once a daily row wins', () => {
    const point = one(
      [hourly('2026-09-11', 9, { impressions: 4, position: 18 }), daily('2026-09-11', 'final', { impressions: 40, position: 12 })],
      '2026-09-11',
    );

    expect(point.hourCoverage).toBeNull();
  });

  it('uses the real day length on a DST date', () => {
    const point = one([hourly('2026-03-08', 0, { impressions: 4, position: 18 })], '2026-03-08');
    expect(point.hourCoverage).toEqual({ hoursWithData: 1, hoursInDay: 23 });
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   Malformed input
   ══════════════════════════════════════════════════════════════════════════ */

describe('malformed input', () => {
  it('ignores an hourly row with no hour', () => {
    const point = one(
      [{ ...hourly('2026-09-09', 0, { impressions: 9, position: 5 }), gscHour: null }],
      '2026-09-09',
    );
    expect(point.source).toBe('none');
  });

  it('ignores a daily row carrying an hour', () => {
    const point = one(
      [{ ...daily('2026-09-09', 'final', { impressions: 9, position: 5 }), gscHour: 3 }],
      '2026-09-09',
    );
    expect(point.source).toBe('none');
  });

  it('ignores rows outside the window rather than throwing', () => {
    const points = resolveGscSeries(
      [daily('2026-01-01', 'final', { impressions: 9, position: 5 })],
      { from: '2026-09-08', to: '2026-09-09' },
    );
    expect(points.every((p) => p.source === 'none')).toBe(true);
  });

  it('rejects a reversed range', () => {
    expect(() => resolveGscSeries([], { from: '2026-09-10', to: '2026-09-08' })).toThrow(
      /must not be after/,
    );
  });

  it('rejects a malformed date argument', () => {
    expect(() => resolveGscSeries([], { from: '10/09/2026', to: '2026-09-12' })).toThrow(
      /YYYY-MM-DD/,
    );
  });

  it('accepts a single-day range', () => {
    expect(resolveGscSeries([], { from: '2026-09-09', to: '2026-09-09' })).toHaveLength(1);
  });

  it('refuses an absurd range instead of allocating it', () => {
    expect(() => resolveGscSeries([], { from: '2000-01-01', to: '2026-01-01' })).toThrow();
  });
});

describe('seriesWindow', () => {
  it('builds an inclusive N-day window ending on the given date', () => {
    expect(seriesWindow('2026-09-12', 7)).toEqual({ from: '2026-09-06', to: '2026-09-12' });
    expect(seriesWindow('2026-09-12', 1)).toEqual({ from: '2026-09-12', to: '2026-09-12' });
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   The scenario the milestone is verified against
   ══════════════════════════════════════════════════════════════════════════ */

describe('the known series for "prestige sector 150 noida"', () => {
  it('resolves final rows across the window without averaging anything away', () => {
    const rows = [
      daily('2026-08-31', 'final', { clicks: 0, impressions: 11, position: 35.09 }),
      daily('2026-09-01', 'final', { clicks: 0, impressions: 14, position: 31.5 }),
      daily('2026-09-05', 'final', { clicks: 1, impressions: 46, position: 15.2 }),
      daily('2026-09-08', 'final', { clicks: 3, impressions: 88, position: 13.4 }),
      daily('2026-09-09', 'final', { clicks: 5, impressions: 122, position: 7.8 }),
    ];

    const points = resolveGscSeries(rows, { from: '2026-08-31', to: '2026-09-09' });

    expect(points).toHaveLength(10);
    expect(points[0]!.position).toBe(35.09);
    expect(points.at(-1)!.position).toBe(7.8);

    // The days in between that Google reported nothing for stay gaps.
    expect(points[1]!.position).toBe(31.5);
    expect(points[2]!.source).toBe('none');
    expect(points[2]!.position).toBeNull();

    // Every rendered point is labelled with where it came from.
    expect(points.filter((p) => p.source !== 'none').every((p) => p.source === 'final')).toBe(true);
  });

  it('shows a same-day provisional figure being revised by reconciliation', () => {
    // Hourly said 35.0 on partial data; the finalised figure is 13.4. Both are
    // retained, which is what makes the size of Google's revision visible.
    const rows = [
      hourly('2026-09-08', 9, { impressions: 4, position: 35 }),
      daily('2026-09-08', 'final', { clicks: 3, impressions: 88, position: 13.4 }),
    ];

    const point = one(rows, '2026-09-08');

    expect(point.source).toBe('final');
    expect(point.position).toBe(13.4);
    expect(point.provisional).toEqual([
      expect.objectContaining({ source: 'hourly', position: 35, positionImpressions: 4 }),
    ]);
  });
});
