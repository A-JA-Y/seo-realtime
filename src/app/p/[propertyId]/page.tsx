import { Card, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { KeywordTable } from '@/components/dashboard/keyword-table';
import { StatTile } from '@/components/dashboard/stat-tile';
import { pageScope } from '@/server/dashboard/page-scope';
import { overview } from '@/server/dashboard/queries';

export const dynamic = 'force-dynamic';

export default async function OverviewPage({
  params,
}: {
  params: Promise<{ propertyId: string }>;
}) {
  const { propertyId } = await params;
  const { scope, property } = await pageScope(propertyId);
  const { tiles, rows } = await overview(scope);

  return (
    <main className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6">
      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {tiles.map((tile) => (
          <StatTile key={tile.label} tile={tile} />
        ))}
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Keywords</CardTitle>
          <CardDescription>
            Two measurements, side by side and never combined: a discrete rank at
            one pinned location and device, and Search Console&rsquo;s
            click-weighted average across every impression Google served.
          </CardDescription>
        </CardHeader>
        <KeywordTable rows={rows} propertyId={propertyId} timeZone={property.timezone} />
      </Card>
    </main>
  );
}
