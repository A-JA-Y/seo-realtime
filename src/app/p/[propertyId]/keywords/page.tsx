import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { KeywordTable } from '@/components/dashboard/keyword-table';
import { pageScope } from '@/server/dashboard/page-scope';
import { keywordRows } from '@/server/dashboard/queries';

export const dynamic = 'force-dynamic';

export default async function KeywordsPage({
  params,
}: {
  params: Promise<{ propertyId: string }>;
}) {
  const { propertyId } = await params;
  const { scope, property } = await pageScope(propertyId);
  const rows = await keywordRows(scope);

  const primaries = rows.filter((r) => r.isPrimary).length;

  return (
    <main className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6">
      <Card>
        <CardHeader>
          <CardTitle>All keywords</CardTitle>
          <CardDescription>
            {rows.length} location/device target{rows.length === 1 ? '' : 's'} ·{' '}
            {primaries} primary. A blank rank is &ldquo;not checked&rdquo;; a
            keyword absent from the fetched results reads &ldquo;not
            found&rdquo;, never position 100.
          </CardDescription>
        </CardHeader>
        <KeywordTable rows={rows} propertyId={propertyId} timeZone={property.timezone} />
      </Card>
    </main>
  );
}
