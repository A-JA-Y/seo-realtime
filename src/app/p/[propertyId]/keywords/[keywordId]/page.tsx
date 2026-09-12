import Link from 'next/link';
import { notFound } from 'next/navigation';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableWrap, Td, Th } from '@/components/ui/table';
import { RankChart } from '@/components/charts/rank-chart';
import { SerpStrip } from '@/components/charts/serp-strip';
import { CheckNowButton } from '@/components/dashboard/check-now';
import { ReconciliationPanel } from '@/components/dashboard/reconciliation-panel';
import { SourceTag } from '@/components/dashboard/source-tag';
import { formatGscDate, formatInstant, formatInteger, formatPosition, shortenUrl } from '@/lib/format';
import { pacificHourToInstant } from '@/lib/gsc-dates';
import { COST_PER_SERP } from '@/server/ingest/dataforseo-client';
import { LIVE_CHECK_COOLDOWN_MS } from '@/server/ingest/serp';
import { keywordDetail } from '@/server/dashboard/detail';
import { pageScope } from '@/server/dashboard/page-scope';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

export default async function KeywordDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ propertyId: string; keywordId: string }>;
  searchParams: Promise<{ target?: string }>;
}) {
  const { propertyId, keywordId } = await params;
  const { target } = await searchParams;
  const { scope, property } = await pageScope(propertyId);

  const detail = await keywordDetail(scope, keywordId, target ?? null);
  if (!detail) notFound();

  const selected = detail.targets.find((t) => t.id === detail.selectedTargetId);
  const latest = detail.history.at(-1);

  /*
   * Two arrays, not one merged table. A live check is an instant; a Search
   * Console date is a Pacific calendar day. They share a time axis — the GSC
   * points are anchored at midday of their own Pacific day — but they are never
   * folded into shared rows, because that would require calling a Pacific day
   * and an IST day the same day.
   */
  const checks = detail.history.map((point) => ({
    t: point.checkedAt.getTime(),
    rankGroup: point.rankGroup,
    rankAbsolute: point.rankAbsolute,
    found: point.found,
  }));

  const gsc = detail.gsc.map((point) => ({
    t: pacificHourToInstant(point.date, 12).getTime(),
    date: point.date,
    position: point.position,
    impressions: point.positionImpressions,
    state: point.source,
    isProvisional: point.isProvisional,
    isLowConfidence: point.isLowConfidence,
  }));

  return (
    <main className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">
            {detail.keyword.term}
            {detail.keyword.isPrimary ? (
              <Badge tone="outline" className="ml-2 align-middle">
                primary
              </Badge>
            ) : null}
          </h2>
          <p className="text-muted-foreground text-xs">
            Last 28 days · times in {property.timezone}
          </p>
        </div>

        {selected ? (
          <CheckNowButton
            keywordTargetId={selected.id}
            costUsd={COST_PER_SERP.live}
            cooldownSeconds={LIVE_CHECK_COOLDOWN_MS / 1000}
            lastCheckedAt={selected.lastLiveCheckAt?.toISOString() ?? null}
          />
        ) : null}
      </header>

      {detail.targets.length > 1 ? (
        <nav className="flex flex-wrap gap-2">
          {detail.targets.map((t) => (
            <Link
              key={t.id}
              href={`/p/${propertyId}/keywords/${keywordId}?target=${t.id}`}
              aria-current={t.id === detail.selectedTargetId ? 'true' : undefined}
              className={cn(
                'rounded-md border px-2.5 py-1 text-xs',
                t.id === detail.selectedTargetId
                  ? 'border-foreground bg-muted font-medium'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t.locationName} · {t.device}
            </Link>
          ))}
        </nav>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Position over time</CardTitle>
          <CardDescription>
            Three series on one inverted axis — position 1 at the top. A gap is
            a gap: no check, or no Search Console data. Nothing here is ever
            plotted at zero or at the bottom of the chart to stand in for
            &ldquo;missing&rdquo;.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <RankChart checks={checks} gsc={gsc} timeZone={property.timezone} />
        </CardContent>
      </Card>

      {detail.reconciliation ? <ReconciliationPanel data={detail.reconciliation} /> : null}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>What was above you</CardTitle>
            <CardDescription>
              From the most recent check{' '}
              {latest ? `· ${formatInstant(latest.checkedAt, property.timezone)}` : ''}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {latest ? (
              <SerpStrip
                features={latest.serpFeatures}
                rankGroup={latest.rankGroup}
                rankAbsolute={latest.rankAbsolute}
                found={latest.found}
              />
            ) : (
              <p className="text-muted-foreground text-sm">No checks yet for this target.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Ranking URL changes</CardTitle>
            <CardDescription>
              A stable position with a changed ranking URL is an event, not a
              non-event — Google swapped which of your pages it prefers.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {detail.urlChanges.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                The same URL has ranked throughout this window
                {latest?.rankingUrl ? `: ${shortenUrl(latest.rankingUrl)}` : '.'}
              </p>
            ) : (
              <ul className="space-y-2 text-sm">
                {detail.urlChanges.map((change) => (
                  <li key={change.at.toISOString()}>
                    <span className="text-muted-foreground text-xs">
                      {formatInstant(change.at, property.timezone)}
                    </span>
                    <p>
                      <span className="text-muted-foreground line-through">
                        {shortenUrl(change.from)}
                      </span>{' '}
                      → <span className="font-medium">{shortenUrl(change.to)}</span>
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Recent checks</CardTitle>
            <CardDescription>
              <SourceTag source="live rank" />
            </CardDescription>
          </CardHeader>
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th>When</Th>
                  <Th className="text-right">Organic</Th>
                  <Th className="text-right">All elements</Th>
                  <Th>Ranking URL</Th>
                </tr>
              </thead>
              <tbody>
                {[...detail.history]
                  .reverse()
                  .slice(0, 12)
                  .map((point) => (
                    <tr key={point.checkedAt.toISOString()}>
                      <Td className="text-xs whitespace-nowrap">
                        {formatInstant(point.checkedAt, property.timezone)}
                      </Td>
                      <Td className="text-right tabular-nums">
                        {point.found ? `#${point.rankGroup}` : <Badge tone="critical">not found</Badge>}
                      </Td>
                      <Td className="text-right tabular-nums">
                        {point.rankAbsolute === null ? '—' : `#${point.rankAbsolute}`}
                      </Td>
                      <Td className="text-muted-foreground max-w-40 truncate text-xs">
                        {shortenUrl(point.rankingUrl)}
                      </Td>
                    </tr>
                  ))}
              </tbody>
            </Table>
          </TableWrap>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Search Console, day by day</CardTitle>
            <CardDescription>
              <SourceTag source="Search Console average" /> · Pacific calendar
              days, exactly as Google assigns them
            </CardDescription>
          </CardHeader>
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th>Date</Th>
                  <Th className="text-right">Avg position</Th>
                  <Th className="text-right">Impressions</Th>
                  <Th className="text-right">Clicks</Th>
                  <Th>State</Th>
                </tr>
              </thead>
              <tbody>
                {[...detail.gsc]
                  .reverse()
                  .slice(0, 12)
                  .map((point) => (
                    <tr key={point.date}>
                      <Td className="text-xs whitespace-nowrap">{formatGscDate(point.date)}</Td>
                      <Td className="text-right tabular-nums">
                        {formatPosition(point.position)}
                      </Td>
                      <Td className="text-right tabular-nums">
                        {formatInteger(point.impressions)}
                      </Td>
                      <Td className="text-right tabular-nums">{formatInteger(point.clicks)}</Td>
                      <Td>
                        {point.source === 'none' ? (
                          <span className="text-muted-foreground text-xs">no data</span>
                        ) : (
                          <span className="text-xs">
                            {point.source}
                            {point.isLowConfidence ? (
                              <Badge tone="warning" className="ml-1">
                                noise
                              </Badge>
                            ) : null}
                          </span>
                        )}
                      </Td>
                    </tr>
                  ))}
              </tbody>
            </Table>
          </TableWrap>
        </Card>
      </div>
    </main>
  );
}
