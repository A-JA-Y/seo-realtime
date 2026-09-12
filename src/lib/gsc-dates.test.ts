import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  dateRange,
  daysBetween,
  pacificDate,
  pacificDayInZone,
  pacificHourToInstant,
  pacificToday,
  reconcileTargetDate,
  shiftDate,
} from './gsc-dates';

const IST = 'Asia/Kolkata';

afterEach(() => {
  vi.useRealTimers();
});

/** Pin the wall clock to a specific instant. */
function at(iso: string) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(iso));
}

describe('pacificDate — the IST day boundary', () => {
  it('is still YESTERDAY in Pacific for most of the Indian working day', () => {
    // 2026-09-12 10:00 IST = 04:30 UTC = 2026-09-11 21:30 PDT.
    // Naively using the Indian date here queries a day Google has no data for
    // yet, and returns an empty row set indistinguishable from a real zero.
    at('2026-09-12T04:30:00Z');
    expect(pacificToday()).toBe('2026-09-11');
  });

  it('catches up only after 12:30 IST', () => {
    // 2026-09-12 13:00 IST = 07:30 UTC = 2026-09-12 00:30 PDT.
    at('2026-09-12T07:30:00Z');
    expect(pacificToday()).toBe('2026-09-12');
  });

  it('is a full day behind at Indian midnight', () => {
    // 2026-09-13 00:00 IST = 2026-09-12 18:30 UTC = 2026-09-12 11:30 PDT.
    at('2026-09-12T18:30:00Z');
    expect(pacificToday()).toBe('2026-09-12');
  });

  it('reports the correct Pacific date exactly at Pacific midnight', () => {
    at('2026-09-12T07:00:00Z'); // 00:00 PDT (UTC-7)
    expect(pacificToday()).toBe('2026-09-12');

    at('2026-09-12T06:59:59Z'); // 23:59:59 PDT the previous day
    expect(pacificToday()).toBe('2026-09-11');
  });
});

describe('pacificDate — DST transitions', () => {
  it('handles the autumn fall-back (PDT → PST, 2026-11-01)', () => {
    // US DST ends 02:00 local on 2026-11-01, so the day has 25 hours.
    at('2026-11-01T08:30:00Z'); // 01:30 PDT, before the shift
    expect(pacificToday()).toBe('2026-11-01');

    at('2026-11-01T10:30:00Z'); // 02:30 PST, after the shift
    expect(pacificToday()).toBe('2026-11-01');

    at('2026-11-02T07:59:00Z'); // 23:59 PST on the 1st (UTC-8 now)
    expect(pacificToday()).toBe('2026-11-01');

    at('2026-11-02T08:01:00Z'); // 00:01 PST on the 2nd
    expect(pacificToday()).toBe('2026-11-02');
  });

  it('handles the spring forward (PST → PDT, 2026-03-08)', () => {
    // The 23-hour day. 02:00–03:00 local does not exist.
    at('2026-03-08T09:30:00Z'); // 01:30 PST
    expect(pacificToday()).toBe('2026-03-08');

    at('2026-03-08T10:30:00Z'); // 03:30 PDT
    expect(pacificToday()).toBe('2026-03-08');
  });

  it('steps back one CALENDAR day across a DST boundary, not 24 hours', () => {
    // Subtracting 24h from midday on 2026-11-02 (PST) lands at 13:00 on the
    // 1st (PDT) — the right day by luck. Subtracting from 00:30 would not.
    at('2026-11-02T08:30:00Z'); // 00:30 PST on the 2nd
    expect(pacificToday()).toBe('2026-11-02');
    expect(pacificToday(-1)).toBe('2026-11-01');
    expect(pacificToday(-2)).toBe('2026-10-31');
  });

  it('crosses a month boundary going backwards', () => {
    at('2026-03-02T20:00:00Z'); // 12:00 PST on the 2nd
    expect(pacificToday(-1)).toBe('2026-03-01');
    expect(pacificToday(-2)).toBe('2026-02-28');
    expect(pacificToday(-3)).toBe('2026-02-27');
  });

  it('handles a leap day', () => {
    at('2024-03-01T20:00:00Z');
    expect(pacificDate(new Date('2024-03-01T20:00:00Z'), -1)).toBe('2024-02-29');
    expect(pacificDate(new Date('2024-03-01T20:00:00Z'), -2)).toBe('2024-02-28');
  });
});

describe('reconcileTargetDate', () => {
  it('targets T−4 in Pacific Time', () => {
    at('2026-09-12T20:00:00Z'); // 13:00 PDT on the 12th
    expect(reconcileTargetDate()).toBe('2026-09-08');
  });

  it('is computed from the Pacific date, not the local one', () => {
    // 04:30 UTC is still 2026-09-11 in Pacific, so T−4 is the 7th, not the 8th.
    at('2026-09-12T04:30:00Z');
    expect(reconcileTargetDate()).toBe('2026-09-07');
  });
});

describe('shiftDate / daysBetween / dateRange', () => {
  it('shifts a plain date string without consulting any timezone', () => {
    expect(shiftDate('2026-09-12', -1)).toBe('2026-09-11');
    expect(shiftDate('2026-01-01', -1)).toBe('2025-12-31');
    expect(shiftDate('2026-11-01', 1)).toBe('2026-11-02'); // DST day
    expect(shiftDate('2024-02-28', 1)).toBe('2024-02-29');
  });

  it('rejects a malformed date', () => {
    expect(() => shiftDate('12/09/2026', 1)).toThrow(/YYYY-MM-DD/);
  });

  it('counts whole days across a DST boundary as whole days', () => {
    // The naive (b - a) / 86400000 without rounding gives 30.958… here.
    expect(daysBetween('2026-10-15', '2026-11-14')).toBe(30);
    expect(daysBetween('2026-09-08', '2026-09-12')).toBe(4);
    expect(daysBetween('2026-09-12', '2026-09-08')).toBe(-4);
  });

  it('expands an inclusive range', () => {
    expect(dateRange('2026-09-10', '2026-09-13')).toEqual([
      '2026-09-10',
      '2026-09-11',
      '2026-09-12',
      '2026-09-13',
    ]);
    expect(dateRange('2026-09-10', '2026-09-10')).toEqual(['2026-09-10']);
    expect(dateRange('2026-09-11', '2026-09-10')).toEqual([]);
  });

  it('refuses to expand an absurd range rather than exhausting memory', () => {
    expect(() => dateRange('2000-01-01', '2026-01-01')).toThrow(/1000 days/);
  });
});

describe('pacificHourToInstant', () => {
  it('maps hour 0 to Pacific midnight, adjusting for DST', () => {
    expect(pacificHourToInstant('2026-09-12', 0).toISOString()).toBe('2026-09-12T07:00:00.000Z');
    expect(pacificHourToInstant('2026-12-12', 0).toISOString()).toBe('2026-12-12T08:00:00.000Z');
  });

  it('maps a mid-day hour correctly', () => {
    expect(pacificHourToInstant('2026-09-12', 14).toISOString()).toBe('2026-09-12T21:00:00.000Z');
  });

  it('rejects an out-of-range hour', () => {
    expect(() => pacificHourToInstant('2026-09-12', 24)).toThrow(/0-23/);
    expect(() => pacificHourToInstant('2026-09-12', -1)).toThrow(/0-23/);
    expect(() => pacificHourToInstant('2026-09-12', 1.5)).toThrow(/0-23/);
  });
});

describe('pacificDayInZone — presentation only', () => {
  it('shows that one Pacific day straddles two IST days', () => {
    // This is why a GSC date cannot simply be relabelled as an IST date.
    const span = pacificDayInZone('2026-09-12', IST);
    expect(span.startLabel).toBe('2026-09-12');
    expect(span.endLabel).toBe('2026-09-13');
    expect(span.spansTwoDays).toBe(true);
  });

  it('does not straddle when the zone is Pacific itself', () => {
    const span = pacificDayInZone('2026-09-12', 'America/Los_Angeles');
    expect(span.spansTwoDays).toBe(false);
  });
});
