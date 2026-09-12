/**
 * Display formatting for the dashboard.
 *
 * One rule runs through all of it: a missing number is rendered as an em dash
 * and never as a zero, a 100, or a blank cell that could be mistaken for one.
 * Domain rule 4 — "not found" is an absence, and the UI has to say so in words.
 */

/**
 * Times are shown in the property's timezone (Asia/Kolkata by default), because
 * the people reading this dashboard are in it. Search Console DATES are a
 * separate thing entirely: they are Pacific calendar days and are never
 * converted — see `formatGscDate`.
 */
export function formatInstant(value: Date | null | undefined, timeZone: string): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(value);
}

export function formatTimeOnly(value: Date | null | undefined, timeZone: string): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(value);
}

/**
 * A Search Console date is a Pacific calendar day, not an instant. Formatting
 * it through a timezone would shift it by a day for half the world, so it is
 * parsed as a bare date and printed as one.
 */
export function formatGscDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);

  // `Number('a')` is NaN, not undefined, so the presence check alone lets a
  // malformed value through to `Intl`, which throws — and a throw here takes
  // the whole page down over one bad string.
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return date;

  /*
   * `timeZone: 'UTC'` is load-bearing, not tidiness.
   *
   * The instant is built at UTC midnight; without this, `Intl` formats it in
   * the RUNTIME timezone and any zone behind UTC renders the previous day. The
   * suite caught this under `TZ=America/Los_Angeles` — which is the machine of
   * exactly the developer most likely to be reading a Pacific date.
   */
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: '2-digit',
    month: 'short',
  }).format(new Date(Date.UTC(y as number, (m as number) - 1, d as number)));
}

export function relativeTime(value: Date | null | undefined, now = new Date()): string {
  if (!value) return 'never';
  const minutes = Math.round((now.getTime() - value.getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** A rank, or the em dash. Never a sentinel. */
export function formatRank(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : String(value);
}

/** An average position keeps one decimal — it is a mean, and reads as one. */
export function formatPosition(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : value.toFixed(1);
}

export function formatInteger(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : value.toLocaleString('en-US');
}

export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

/** `https://example.com/a/b?c=d` → `/a/b` — enough to see a URL change. */
export function shortenUrl(url: string | null | undefined): string {
  if (!url) return '—';
  try {
    const parsed = new URL(url);
    const path = parsed.pathname === '/' ? '/' : parsed.pathname.replace(/\/$/, '');
    return path;
  } catch {
    return url;
  }
}

export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}
