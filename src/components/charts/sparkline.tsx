'use client';

import { Line, LineChart, ResponsiveContainer, YAxis } from 'recharts';

import { rankDomain } from './chart-theme';

/**
 * A tile sparkline: shape only, no axes, no tooltip.
 *
 * It carries the same two rules as the full chart — the y axis is inverted so
 * "up" means a better position, and a null day is a gap rather than a drop to
 * the floor. A sparkline that dives to zero on a day with no data tells the
 * reader a rank collapsed when nothing happened at all.
 */
export function Sparkline({
  data,
  color = 'var(--source-serp)',
  height = 32,
}: {
  data: ReadonlyArray<{ day: string; value: number | null }>;
  color?: string;
  height?: number;
}) {
  if (data.length < 2) return null;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data as Array<{ day: string; value: number | null }>} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
        <YAxis reversed hide domain={rankDomain(data.map((d) => d.value))} />
        <Line
          type="monotone"
          dataKey="value"
          stroke={color}
          strokeWidth={2}
          dot={false}
          connectNulls={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
