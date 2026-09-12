import { cn } from '@/lib/utils';
import type { SerpFeatures } from '@/server/ingest/serp-parse';
import { describeFeatures } from '@/server/dashboard/reconciliation';

/**
 * What sits above you on the page (§11: "SERP composition strip").
 *
 * This is the picture behind the gap between `rank_group` and `rank_absolute`:
 * being #3 organically means very little when an AI Overview, a local pack and
 * two ads are stacked above the first blue link. Each block is named in words,
 * because the colours here are a texture, not an encoding.
 */
export function SerpStrip({
  features,
  rankGroup,
  rankAbsolute,
  found = true,
  className,
}: {
  features: SerpFeatures | null;
  rankGroup: number | null;
  rankAbsolute: number | null;
  found?: boolean;
  className?: string;
}) {
  if (!found) {
    return (
      <p className={cn('text-muted-foreground text-sm', className)}>
        The domain was not in the fetched results on this check, so there is no
        position to sit anything above.
      </p>
    );
  }

  // `describeFeatures` already names the ads. Counting them again here is how
  // the strip ended up reading "2 Ads · 2 ads above".
  const named = describeFeatures(features);
  const gap = rankGroup !== null && rankAbsolute !== null ? rankAbsolute - rankGroup : null;

  if (named.length === 0) {
    return (
      <p className={cn('text-muted-foreground text-xs', className)}>
        Nothing but organic results above you on this check.
      </p>
    );
  }

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex flex-wrap gap-1.5">
        {named.map((name) => (
          <span
            key={name}
            className="bg-muted text-foreground rounded-md px-2 py-0.5 text-xs capitalize"
          >
            {name.replace(/^(an?|the) /, '')}
          </span>
        ))}
      </div>
      {gap !== null && gap > 0 ? (
        <p className="text-muted-foreground text-xs">
          {gap} place{gap === 1 ? '' : 's'} between your organic rank (#{rankGroup}) and your
          position counting every element (#{rankAbsolute}).
        </p>
      ) : null}
    </div>
  );
}
