import Link from 'next/link';

import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AlertActions, MarkAllRead } from '@/components/dashboard/alert-actions';
import { formatGscDate, formatInstant, relativeTime } from '@/lib/format';
import { pageScope } from '@/server/dashboard/page-scope';
import { listAlerts } from '@/server/dashboard/queries';
import { BASELINE_DAYS } from '@/server/alerts/engine';
import { MIN_CHECKS_PER_DAY } from '@/server/alerts/rules';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

/**
 * Severity → status colour. Reserved: never reused as a series colour, and
 * always beside the word, so hue never carries the meaning alone.
 */
const TONE: Record<string, BadgeTone> = {
  info: 'neutral',
  warning: 'warning',
  critical: 'critical',
};

/** The measurement each alert type is derived from (acceptance criterion 7). */
const SOURCE: Record<string, string> = {
  rank_drop: 'best organic rank of the day, from the rollup',
  rank_gain: 'best organic rank of the day, from the rollup',
  lost_top_10: 'best organic rank of the day, from the rollup',
  entered_top_10: 'best organic rank of the day, from the rollup',
  lost_from_index: 'every live check that day',
  ranking_url_changed: 'the last found check of each day',
  new_competitor_top_3: 'the competitor list on the last check of each day',
  ingest_failure: 'the ingest run log',
};

export default async function AlertsPage({
  params,
}: {
  params: Promise<{ propertyId: string }>;
}) {
  const { propertyId } = await params;
  const { scope, property } = await pageScope(propertyId);
  const alerts = await listAlerts(scope);

  const unread = alerts.filter((a) => a.readAt === null && a.resolvedAt === null).length;

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-4 py-6 sm:px-6">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <CardTitle>Alerts</CardTitle>
              <CardDescription>
                In-app only, by design — there is no email or Slack delivery in
                this product. Baselines are the best organic rank of a day{' '}
                {BASELINE_DAYS} days back, taken from the rollups and never from
                a single check; a day resting on fewer than {MIN_CHECKS_PER_DAY}{' '}
                checks is not judged at all.
              </CardDescription>
            </div>
            <MarkAllRead propertyId={propertyId} unread={unread} />
          </div>
        </CardHeader>

        <CardContent>
          {alerts.length === 0 ? (
            <div className="py-8 text-center">
              <p className="text-sm font-medium">Nothing to report.</p>
              <p className="text-muted-foreground mt-1 text-sm">
                No keyword has moved enough to be worth your attention. The
                engine runs after each rollup.
              </p>
            </div>
          ) : (
            <ul className="divide-y">
              {alerts.map((alert) => {
                const resolved = alert.resolvedAt !== null;
                const day = typeof alert.payload['day'] === 'string' ? alert.payload['day'] : null;

                return (
                  <li
                    key={alert.id}
                    className={cn('space-y-2 py-4 first:pt-0 last:pb-0', resolved && 'opacity-60')}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      {alert.readAt === null && !resolved ? (
                        <span
                          aria-label="unread"
                          className="bg-foreground size-1.5 shrink-0 rounded-full"
                        />
                      ) : null}
                      <Badge tone={TONE[alert.severity] ?? 'neutral'}>{alert.severity}</Badge>
                      <span className="text-sm font-medium">{alert.title}</span>
                      {resolved ? <Badge tone="good">resolved</Badge> : null}
                      <span
                        className="text-muted-foreground ml-auto text-xs"
                        title={formatInstant(alert.createdAt, property.timezone)}
                      >
                        {relativeTime(alert.createdAt)}
                      </span>
                    </div>

                    <p className="text-muted-foreground text-sm leading-relaxed">{alert.body}</p>

                    <p className="text-muted-foreground text-[11px]">
                      {SOURCE[alert.type] ?? alert.type}
                      {day ? ` · judged on ${formatGscDate(day)}` : ''}
                    </p>

                    <div className="flex flex-wrap items-center gap-3">
                      {alert.keywordId ? (
                        <Link
                          href={`/p/${propertyId}/keywords/${alert.keywordId}${
                            alert.keywordTargetId ? `?target=${alert.keywordTargetId}` : ''
                          }`}
                          className="text-xs underline underline-offset-4"
                        >
                          Open the keyword
                        </Link>
                      ) : null}
                      <AlertActions
                        alertId={alert.id}
                        isRead={alert.readAt !== null}
                        isResolved={resolved}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
