import Link from 'next/link';

import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { relativeTime } from '@/lib/format';
import { pageScope } from '@/server/dashboard/page-scope';
import { listAlerts } from '@/server/dashboard/queries';

export const dynamic = 'force-dynamic';

/** Severity → status colour. Never a series colour, and always beside a word. */
const TONE: Record<string, BadgeTone> = {
  info: 'neutral',
  warning: 'warning',
  critical: 'critical',
};

export default async function AlertsPage({
  params,
}: {
  params: Promise<{ propertyId: string }>;
}) {
  const { propertyId } = await params;
  const { scope } = await pageScope(propertyId);
  const alerts = await listAlerts(scope);

  return (
    <main className="mx-auto max-w-4xl space-y-6 px-4 py-6 sm:px-6">
      <Card>
        <CardHeader>
          <CardTitle>Alerts</CardTitle>
          <CardDescription>
            In-app only, by design — there is no email or Slack delivery in this
            product. Every alert names the measurement it came from.
          </CardDescription>
        </CardHeader>

        <CardContent>
          {alerts.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Nothing raised yet.
            </p>
          ) : (
            <ul className="divide-y">
              {alerts.map((alert) => (
                <li key={alert.id} className="py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={TONE[alert.severity] ?? 'neutral'}>{alert.severity}</Badge>
                    <span className="text-sm font-medium">{alert.title}</span>
                    {alert.resolvedAt ? <Badge tone="good">resolved</Badge> : null}
                    <span className="text-muted-foreground ml-auto text-xs">
                      {relativeTime(alert.createdAt)}
                    </span>
                  </div>
                  <p className="text-muted-foreground mt-1 text-sm leading-relaxed">
                    {alert.body}
                  </p>
                  {alert.keywordId ? (
                    <Link
                      href={`/p/${propertyId}/keywords/${alert.keywordId}`}
                      className="text-xs underline underline-offset-4"
                    >
                      Open the keyword
                    </Link>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
