'use client';

import { useId, useMemo } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { formatGscDate, formatInstant, formatInteger, formatPosition } from '@/lib/format';
import { AXIS, rankDomain, rankTicks, SERIES } from './chart-theme';

/** One live check, at the instant it happened. */
export interface RankChartCheck {
  t: number;
  rankGroup: number | null;
  rankAbsolute: number | null;
  found: boolean;
}

/**
 * One Search Console day, anchored at midday of its PACIFIC date.
 *
 * The anchor matters. A GSC date is a Pacific calendar day and a live check is
 * an instant; the only axis on which both are honestly placeable is real time.
 * Plotting them against a shared "day" index would quietly equate a Pacific day
 * with the property's local day, which are 12.5–13.5 hours apart (§14).
 */
export interface RankChartGscPoint {
  t: number;
  date: string;
  position: number | null;
  impressions: number | null;
  state: string;
  isProvisional: boolean;
  isLowConfidence: boolean;
}

interface Props {
  checks: readonly RankChartCheck[];
  gsc: readonly RankChartGscPoint[];
  timeZone: string;
  height?: number;
}

/** Contiguous stretches where every check came back not-found. */
function notFoundRuns(checks: readonly RankChartCheck[]): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  let start: number | null = null;
  let previous: number | null = null;

  for (const check of checks) {
    if (!check.found) {
      if (start === null) start = previous ?? check.t;
    } else if (start !== null) {
      runs.push([start, check.t]);
      start = null;
    }
    previous = check.t;
  }
  if (start !== null && previous !== null) runs.push([start, previous]);

  return runs.filter(([a, b]) => b > a);
}

export function RankChart({ checks, gsc, timeZone, height = 320 }: Props) {
  const gradientId = useId();

  const domain = useMemo(
    () =>
      rankDomain([
        ...checks.flatMap((c) => [c.rankGroup, c.rankAbsolute]),
        ...gsc.map((g) => g.position),
      ]),
    [checks, gsc],
  );

  const runs = useMemo(() => notFoundRuns(checks), [checks]);

  const bounds = useMemo(() => {
    const all = [...checks.map((c) => c.t), ...gsc.map((g) => g.t)];
    if (all.length === 0) return undefined;
    return [Math.min(...all), Math.max(...all)] as [number, number];
  }, [checks, gsc]);

  if (bounds === undefined) {
    return (
      <div
        className="text-muted-foreground flex items-center justify-center rounded-lg border border-dashed text-sm"
        style={{ height }}
      >
        No checks or Search Console data yet for this window.
      </div>
    );
  }

  return (
    <div>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart margin={{ top: 14, right: 12, bottom: 4, left: -8 }}>
          <defs>
            {/*
              Diagonal hatch for the not-found band. A tint alone would read as
              a value; a texture reads as "this region is a state, not a
              measurement", and survives greyscale printing and forced-colors.
            */}
            <pattern
              id={gradientId}
              width="8"
              height="8"
              patternTransform="rotate(45)"
              patternUnits="userSpaceOnUse"
            >
              <rect width="8" height="8" fill="var(--muted)" />
              <line x1="0" y1="0" x2="0" y2="8" stroke="var(--border)" strokeWidth="3" />
            </pattern>
          </defs>

          <CartesianGrid stroke={AXIS.stroke} strokeDasharray="2 4" vertical={false} />

          {runs.map(([from, to]) => (
            <ReferenceArea
              key={`${from}-${to}`}
              x1={from}
              x2={to}
              fill={`url(#${gradientId})`}
              fillOpacity={0.75}
              ifOverflow="extendDomain"
            />
          ))}

          <XAxis
            type="number"
            dataKey="t"
            domain={bounds}
            scale="time"
            allowDuplicatedCategory={false}
            tickFormatter={(value: number) =>
              new Intl.DateTimeFormat('en-GB', {
                timeZone,
                day: '2-digit',
                month: 'short',
              }).format(new Date(value))
            }
            axisLine={{ stroke: AXIS.stroke }}
            tickLine={false}
            tick={AXIS.tick}
            minTickGap={44}
          />

          {/*
            Inverted: position 1 sits at the TOP, because that is what "first"
            means to every reader. A rank chart drawn the other way up reads as
            improvement when things got worse.
          */}
          <YAxis
            reversed
            domain={domain}
            ticks={rankTicks(domain)}
            allowDecimals={false}
            width={44}
            axisLine={false}
            tickLine={false}
            tick={AXIS.tick}
            label={undefined}
          />

          <Tooltip
            cursor={{ stroke: AXIS.stroke, strokeWidth: 1 }}
            content={<RankTooltip timeZone={timeZone} gsc={gsc} />}
            isAnimationActive={false}
          />

          <Line
            data={checks as RankChartCheck[]}
            type="monotone"
            dataKey="rankGroup"
            name={SERIES.rankGroup.name}
            stroke={SERIES.rankGroup.color}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 5, strokeWidth: 2, stroke: 'var(--card)' }}
            connectNulls={false}
            isAnimationActive={false}
          />
          <Line
            data={checks as RankChartCheck[]}
            type="monotone"
            dataKey="rankAbsolute"
            name={SERIES.rankAbsolute.name}
            stroke={SERIES.rankAbsolute.color}
            strokeWidth={2}
            strokeDasharray={SERIES.rankAbsolute.dash}
            dot={false}
            activeDot={{ r: 5, strokeWidth: 2, stroke: 'var(--card)' }}
            connectNulls={false}
            isAnimationActive={false}
          />
          <Line
            data={gsc as RankChartGscPoint[]}
            type="monotone"
            dataKey="position"
            name={SERIES.gsc.name}
            stroke={SERIES.gsc.color}
            strokeWidth={2}
            strokeDasharray={SERIES.gsc.dash}
            dot={false}
            activeDot={{ r: 5, strokeWidth: 2, stroke: 'var(--card)' }}
            connectNulls={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>

      <RankLegend hasNotFound={runs.length > 0} />
    </div>
  );
}

/**
 * The legend names the SOURCE of each series, not just the series.
 *
 * §11: "an explicit legend naming the source of each". Two of these lines come
 * from a rank checker and one from Search Console, and a reader who does not
 * know which is which will average them in their head — which is domain rule 1,
 * the one thing this product exists not to do.
 */
function RankLegend({ hasNotFound }: { hasNotFound: boolean }) {
  const entries = [SERIES.rankGroup, SERIES.rankAbsolute, SERIES.gsc];

  return (
    <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-2 px-2 text-xs">
      {entries.map((series) => (
        <li key={series.name} className="flex items-center gap-2">
          <svg width="22" height="8" aria-hidden className="shrink-0">
            <line
              x1="0"
              y1="4"
              x2="22"
              y2="4"
              stroke={series.color}
              strokeWidth="2"
              strokeDasharray={series.dash}
            />
          </svg>
          <span className="text-foreground font-medium">{series.name}</span>
          <span className="text-muted-foreground">{series.source}</span>
        </li>
      ))}
      {hasNotFound ? (
        <li className="flex items-center gap-2">
          <svg width="22" height="10" aria-hidden className="shrink-0">
            <rect width="22" height="10" fill="var(--muted)" />
            <line x1="0" y1="10" x2="10" y2="0" stroke="var(--border)" strokeWidth="3" />
            <line x1="12" y1="10" x2="22" y2="0" stroke="var(--border)" strokeWidth="3" />
          </svg>
          <span className="text-foreground font-medium">Not found</span>
          <span className="text-muted-foreground">absent from the fetched results — not position 100</span>
        </li>
      ) : null}
    </ul>
  );
}

interface TooltipPayloadEntry {
  dataKey?: string | number;
  value?: number | null;
  payload?: Record<string, unknown>;
}

function RankTooltip({
  active,
  label,
  payload,
  timeZone,
  gsc,
}: {
  active?: boolean;
  label?: number;
  payload?: TooltipPayloadEntry[];
  timeZone: string;
  gsc: readonly RankChartGscPoint[];
}) {
  if (!active || label === undefined) return null;

  const entries = payload ?? [];
  const check = entries.find((e) => e.dataKey === 'rankGroup' || e.dataKey === 'rankAbsolute')
    ?.payload as RankChartCheck | undefined;

  /*
   * Resolved from the hovered INSTANT, never from Recharts' payload entry for
   * the GSC line.
   *
   * This chart gives each series its own `data` array, and Recharts builds its
   * tooltip index from the CONCATENATION of them all. A check timestamp never
   * equals a Pacific-midday anchor, so its lookup by value misses and it falls
   * back to the positional index — handing back the Nth GSC day for the Nth
   * check. Hovering the 18th check on a 28-day chart showed that check's time
   * beside a Search Console day two weeks away, with no sign anything was
   * wrong.
   *
   * GSC anchors sit 24 hours apart at Pacific midday, so a ±12h window contains
   * exactly one: the Pacific day the hovered instant actually falls in.
   */
  const gscDay = gsc.reduce<RankChartGscPoint | undefined>((best, point) => {
    const delta = Math.abs(point.t - label);
    if (delta > 12 * 3_600_000) return best;
    if (!best || delta < Math.abs(best.t - label)) return point;
    return best;
  }, undefined);

  return (
    <div className="bg-popover text-popover-foreground min-w-56 rounded-lg border p-3 text-xs shadow-md">
      <p className="text-foreground font-medium">{formatInstant(new Date(label), timeZone)}</p>

      {check ? (
        <div className="mt-2 space-y-1">
          <p className="text-muted-foreground">Live rank check</p>
          {check.found ? (
            <>
              <Row color={SERIES.rankGroup.color} name="Organic rank">
                #{check.rankGroup ?? '—'}
              </Row>
              <Row color={SERIES.rankAbsolute.color} name="All elements">
                #{check.rankAbsolute ?? '—'}
              </Row>
              {check.rankGroup !== null && check.rankAbsolute !== null ? (
                <p className="text-muted-foreground">
                  {check.rankAbsolute - check.rankGroup} block
                  {check.rankAbsolute - check.rankGroup === 1 ? '' : 's'} of SERP furniture above you
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-foreground">Not found in the fetched results</p>
          )}
        </div>
      ) : null}

      {gscDay ? (
        <div className="mt-2 space-y-1 border-t pt-2">
          <p className="text-muted-foreground">
            Search Console · {formatGscDate(gscDay.date)} (Pacific day)
          </p>
          {/*
            A day we hold nothing for is not a small measurement, it is no
            measurement. `isLowConfidence` is true for those too (zero is under
            three), so without this guard the tooltip described an empty day as
            a reading too small to trust — while the table on the same page said
            "no data".
          */}
          {gscDay.state === 'none' ? (
            <p className="text-muted-foreground">
              Google returned nothing for this day — not a small number, no rows.
            </p>
          ) : (
            <>
              <Row color={SERIES.gsc.color} name="Average position">
                {formatPosition(gscDay.position)}
              </Row>
              <p className="text-muted-foreground">
                {formatInteger(gscDay.impressions)} impressions
                {gscDay.isProvisional ? ' · provisional, Google may revise' : ''}
              </p>
              {gscDay.isLowConfidence ? (
                <p className="text-muted-foreground">Under 3 impressions — treat as noise</p>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function Row({
  color,
  name,
  children,
}: {
  color: string;
  name: string;
  children: React.ReactNode;
}) {
  return (
    <p className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground inline-flex items-center gap-1.5">
        <span
          aria-hidden
          className="size-2 shrink-0 rounded-[2px]"
          style={{ backgroundColor: color }}
        />
        {name}
      </span>
      <span className="text-foreground font-medium tabular-nums">{children}</span>
    </p>
  );
}
