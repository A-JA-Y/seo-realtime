/**
 * Shared chart constants.
 *
 * The three series colours are CSS custom properties defined in `globals.css`
 * and validated with the data-viz palette checker (categorical slots 1–3, both
 * modes, all-pairs): worst CVD ΔE 9.2 light / 9.4 dark, worst normal-vision ΔE
 * 24.0 light / 20.9 dark. Referencing them by role rather than by hex is what
 * lets dark mode be a *selected* set of steps instead of an automatic flip.
 *
 * Colour is never the only channel. Each series also carries its own stroke
 * pattern, because clients print these charts in greyscale.
 */
export const SERIES = {
  rankGroup: {
    key: 'rankGroup',
    color: 'var(--source-serp)',
    dash: undefined,
    name: 'Organic rank (rank_group)',
    source: 'Live rank check — DataForSEO',
  },
  gsc: {
    key: 'position',
    color: 'var(--source-gsc)',
    dash: '6 4',
    name: 'Average position',
    source: 'Search Console — click-weighted mean',
  },
  rankAbsolute: {
    key: 'rankAbsolute',
    color: 'var(--source-absolute)',
    dash: '2 3',
    name: 'All-elements rank (rank_absolute)',
    source: 'Live rank check — DataForSEO',
  },
} as const;

export const AXIS = {
  stroke: 'var(--border)',
  tick: { fill: 'var(--muted-foreground)', fontSize: 11 },
} as const;

/**
 * A y-domain that always starts at position 1 and never invents headroom that
 * pushes real movement into a flat line at the top.
 */
export function rankDomain(values: readonly (number | null)[]): [number, number] {
  const present = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (present.length === 0) return [1, 10];
  const max = Math.max(...present);
  const padded = Math.ceil((max + Math.max(1, max * 0.08)) / 5) * 5;
  return [1, Math.max(5, padded)];
}

/**
 * Ticks that always include position 1.
 *
 * Recharts picks its own round numbers, which for a domain of [1, 25] gives
 * 7 / 13 / 19 / 25 and leaves the top of the chart unlabelled — on an inverted
 * rank axis the top is the number everyone is looking for.
 */
export function rankTicks([min, max]: [number, number]): number[] {
  const span = max - min;
  const step = span <= 10 ? 2 : span <= 30 ? 5 : span <= 60 ? 10 : 20;

  const ticks = [1];
  for (let value = step; value <= max; value += step) ticks.push(value);
  if (ticks[ticks.length - 1] !== max) ticks.push(max);
  return ticks;
}
