import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Emphasis } from '@/components/dashboard/emphasis';
import { SourceTag } from '@/components/dashboard/source-tag';
import { formatGscDate, formatInteger, formatPosition } from '@/lib/format';
import type { Reconciliation } from '@/server/dashboard/reconciliation';

/**
 * The reconciliation panel (§8) — the feature this product is actually for.
 *
 * A client sees "average position 11.6" in Search Console and "you're #8" from
 * us on the same day and concludes one of us is lying. Neither is: they are
 * different measurements. This panel puts both numbers on screen with their
 * sources attached and explains the distance between them in words, naming the
 * specific SERP blocks responsible.
 */
export function ReconciliationPanel({ data }: { data: Reconciliation }) {
  const { gsc, targets, explanation } = data;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Why these two numbers differ</CardTitle>
        <CardDescription>
          Search Console&rsquo;s {formatGscDate(gsc.date)} figure against the
          nearest live checks. Pacific calendar day — Google assigns it, and we
          never shift it.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="bg-muted/40 rounded-lg p-3">
            <SourceTag source="Search Console average" />
            <p className="mt-1 text-xl font-semibold tabular-nums">
              {formatPosition(gsc.position)}
            </p>
            <p className="text-muted-foreground text-xs">
              {formatInteger(gsc.impressions)} impressions · {gsc.state}
              {gsc.isProvisional ? ' · provisional' : ''}
            </p>
            {gsc.confidence === 'low' ? (
              <Badge tone="warning" className="mt-2">
                under 3 impressions — noise
              </Badge>
            ) : null}
          </div>

          <div className="bg-muted/40 space-y-3 rounded-lg p-3">
            <SourceTag source="live rank" />
            {targets.length === 0 ? (
              <p className="text-muted-foreground text-xs">No live check near this date.</p>
            ) : (
              targets.map((target) => (
                <div key={target.keywordTargetId}>
                  <p className="text-sm">
                    {target.found ? (
                      <>
                        <span className="font-semibold tabular-nums">#{target.rankGroup}</span>
                        <span className="text-muted-foreground"> organic</span>
                        <span className="text-muted-foreground"> · </span>
                        <span className="font-semibold tabular-nums">#{target.rankAbsolute}</span>
                        <span className="text-muted-foreground"> all elements</span>
                      </>
                    ) : (
                      <Badge tone="critical">not found</Badge>
                    )}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {target.locationName} · {target.device}
                    {target.hoursFromDate !== null
                      ? ` · ${Math.round(target.hoursFromDate)}h from midday`
                      : ''}
                  </p>
                </div>
              ))
            )}
          </div>
        </div>

        <ul className="space-y-2 text-sm leading-relaxed">
          {explanation.map((line) => (
            <li key={line} className="flex gap-2">
              <span aria-hidden className="text-muted-foreground shrink-0">
                •
              </span>
              <span>
                <Emphasis text={line} />
              </span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
