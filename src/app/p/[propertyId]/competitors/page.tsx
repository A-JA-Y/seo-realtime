import { Badge } from '@/components/ui/badge';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableWrap, Td, Th } from '@/components/ui/table';
import { SourceTag } from '@/components/dashboard/source-tag';
import { relativeTime } from '@/lib/format';
import { pageScope } from '@/server/dashboard/page-scope';
import { competitors } from '@/server/dashboard/queries';

export const dynamic = 'force-dynamic';

export default async function CompetitorsPage({
  params,
}: {
  params: Promise<{ propertyId: string }>;
}) {
  const { propertyId } = await params;
  const { scope } = await pageScope(propertyId);
  const rows = await competitors(scope);

  return (
    <main className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6">
      <Card>
        <CardHeader>
          <CardTitle>Competitors</CardTitle>
          <CardDescription>
            Every domain appearing on your tracked SERPs, from the competitor
            lists already captured on each check. These are organic ranks from
            live checks only — Search Console has nothing to say about anyone
            else&rsquo;s site.
          </CardDescription>
        </CardHeader>

        {rows.length === 0 ? (
          <p className="text-muted-foreground px-5 py-8 text-center text-sm">
            No checks with competitor data yet.
          </p>
        ) : (
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th>Domain</Th>
                  <Th className="text-right">SERPs</Th>
                  <Th className="text-right">
                    Best rank
                    <SourceTag source="live rank" className="mt-1 flex justify-end" />
                  </Th>
                  <Th className="text-right">Average rank</Th>
                  <Th>Outranks you on</Th>
                  <Th className="text-right">Last seen</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.domain} className="hover:bg-muted/40">
                    <Td className="font-medium">{row.domain}</Td>
                    <Td className="text-right tabular-nums">{row.appearances}</Td>
                    <Td className="text-right tabular-nums">#{row.bestRank}</Td>
                    <Td className="text-right tabular-nums">{row.averageRank.toFixed(1)}</Td>
                    <Td>
                      {row.outranksUsOn.length === 0 ? (
                        <span className="text-muted-foreground text-xs">—</span>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {row.outranksUsOn.slice(0, 4).map((term) => (
                            <Badge key={term} tone="serious">
                              {term}
                            </Badge>
                          ))}
                          {row.outranksUsOn.length > 4 ? (
                            <Badge tone="neutral">+{row.outranksUsOn.length - 4}</Badge>
                          ) : null}
                        </div>
                      )}
                    </Td>
                    <Td className="text-muted-foreground text-right text-xs whitespace-nowrap">
                      {relativeTime(row.lastSeen)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </Card>
    </main>
  );
}
