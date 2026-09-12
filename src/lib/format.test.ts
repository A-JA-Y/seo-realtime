import { describe, expect, it } from 'vitest';

import {
  formatGscDate,
  formatInstant,
  formatInteger,
  formatPosition,
  formatRank,
  formatUsd,
  hostOf,
  relativeTime,
  shortenUrl,
} from './format';

describe('formatGscDate', () => {
  /*
   * The one that matters. A Search Console date is a Pacific calendar day, and
   * the whole product depends on never shifting it. Formatting it as an instant
   * would move it a day for anyone east of UTC — including every reader of this
   * dashboard, which defaults to Asia/Kolkata.
   */
  it('never shifts the day, whatever the runtime timezone', () => {
    // Run this file under `pnpm test:tz` too. It failed there first: the
    // formatter was rendering a UTC-midnight instant in the local zone, so
    // every Search Console date on the dashboard moved back a day for anyone
    // west of UTC.
    expect(formatGscDate('2026-09-12')).toBe('12 Sept');
    expect(formatGscDate('2026-01-01')).toBe('01 Jan');
    expect(formatGscDate('2026-12-31')).toBe('31 Dec');
    expect(formatGscDate('2026-03-08')).toBe('08 Mar'); // US DST transition
    expect(formatGscDate('2026-11-01')).toBe('01 Nov'); // and back again
  });

  it('leaves an unparseable value alone rather than inventing a date', () => {
    expect(formatGscDate('not-a-date')).toBe('not-a-date');
  });
});

describe('missing values', () => {
  // Domain rule 4: "not found" is an absence. Never a zero, never a 100.
  it.each([
    ['formatRank', formatRank],
    ['formatPosition', formatPosition],
    ['formatInteger', formatInteger],
    ['formatUsd', formatUsd],
  ])('%s renders null as an em dash', (_name, fn) => {
    expect(fn(null)).toBe('—');
    expect(fn(undefined)).toBe('—');
  });

  it('renders a measured zero as zero, which is not the same thing', () => {
    expect(formatInteger(0)).toBe('0');
    expect(formatPosition(0)).toBe('0.0');
  });

  it('keeps one decimal on an average position, because it is a mean', () => {
    expect(formatPosition(11.63)).toBe('11.6');
    expect(formatPosition(11)).toBe('11.0');
  });

  it('keeps a rank a whole number', () => {
    expect(formatRank(8)).toBe('8');
  });
});

describe('formatInstant', () => {
  it('renders in the property timezone, not the runtime one', () => {
    const at = new Date('2026-09-12T20:00:00Z');
    expect(formatInstant(at, 'Asia/Kolkata')).toBe('13 Sept, 01:30');
    expect(formatInstant(at, 'UTC')).toBe('12 Sept, 20:00');
  });

  it('says so when there is no instant', () => {
    expect(formatInstant(null, 'UTC')).toBe('—');
  });
});

describe('relativeTime', () => {
  const now = new Date('2026-09-12T12:00:00Z');

  it.each([
    [new Date('2026-09-12T11:59:40Z'), 'just now'],
    [new Date('2026-09-12T11:30:00Z'), '30m ago'],
    [new Date('2026-09-12T06:00:00Z'), '6h ago'],
    [new Date('2026-09-09T12:00:00Z'), '3d ago'],
  ])('%s → %s', (at, expected) => {
    expect(relativeTime(at, now)).toBe(expected);
  });

  it('says "never" rather than pretending there was a check', () => {
    expect(relativeTime(null, now)).toBe('never');
  });
});

describe('shortenUrl', () => {
  it('keeps the path, which is what changes when Google swaps pages', () => {
    expect(shortenUrl('https://example.com/projects/sector-150')).toBe('/projects/sector-150');
    expect(shortenUrl('https://example.com/a/b/?utm=x')).toBe('/a/b');
    expect(shortenUrl('https://example.com/')).toBe('/');
  });

  it('passes a non-URL through instead of throwing on a page render', () => {
    expect(shortenUrl('not a url')).toBe('not a url');
    expect(shortenUrl(null)).toBe('—');
  });
});

describe('hostOf', () => {
  it('extracts the host, or null', () => {
    expect(hostOf('https://sub.example.com/x')).toBe('sub.example.com');
    expect(hostOf('nonsense')).toBeNull();
    expect(hostOf(null)).toBeNull();
  });
});
