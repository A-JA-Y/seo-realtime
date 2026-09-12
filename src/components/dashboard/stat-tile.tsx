import { Card, CardContent } from '@/components/ui/card';
import { Sparkline } from '@/components/charts/sparkline';
import { Delta } from '@/components/dashboard/delta';
import { SourceTag } from '@/components/dashboard/source-tag';
import type { OverviewTile } from '@/server/dashboard/queries';

/**
 * A headline number is a stat tile, not a chart — one value does not need axes.
 *
 * The source line is not decoration. A tile reading "10.0" means one thing if
 * it came from a rank checker and a materially different thing if it came from
 * Search Console, and a reader who cannot tell will act on the wrong one.
 */
export function StatTile({ tile }: { tile: OverviewTile }) {
  return (
    <Card>
      <CardContent className="space-y-2">
        <p className="text-muted-foreground text-xs">{tile.label}</p>
        <p className="text-2xl font-semibold tabular-nums">{tile.value}</p>
        <SourceTag source={tile.source} />
        <div className="flex items-center gap-2">
          {tile.delta !== null ? (
            <Delta value={tile.delta} lowerIsBetter={tile.lowerIsBetter} />
          ) : null}
          <span className="text-muted-foreground text-xs">{tile.deltaLabel}</span>
        </div>
        {tile.note ? <p className="text-muted-foreground text-xs">{tile.note}</p> : null}
        {tile.sparkline.length > 1 ? (
          <div className="pt-1">
            <Sparkline data={tile.sparkline} />
            <p className="text-muted-foreground mt-1 text-[11px]">last 7 days</p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
