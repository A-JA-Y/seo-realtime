import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Table, TableWrap, Td, Th } from '@/components/ui/table';
import { Delta } from '@/components/dashboard/delta';
import { SourceTag } from '@/components/dashboard/source-tag';
import { formatGscDate, formatInteger, formatPosition, relativeTime } from '@/lib/format';
import type { KeywordRow } from '@/server/dashboard/queries';

/**
 * The keyword table.
 *
 * The two position columns are deliberately far apart and separately headed.
 * They are different measurements — a discrete rank at one pinned location and
 * device, and a click-weighted mean across every impression Google served —
 * and the whole point of this product is that they are never averaged, never
 * subtracted from each other, and never shown as one number.
 */
export function KeywordTable({
  rows,
  propertyId,
  timeZone,
}: {
  rows: readonly KeywordRow[];
  propertyId: string;
  timeZone: string;
}) {
  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground px-5 py-8 text-center text-sm">
        No active keywords yet.
      </p>
    );
  }

  return (
    <>
      <KeywordCards rows={rows} propertyId={propertyId} />
      <TableWrap className="hidden sm:block">
      <Table>
        <thead>
          <tr>
            <Th>Keyword</Th>
            <Th>Target</Th>
            <Th className="text-right">
              Organic rank
              <SourceTag source="live rank" className="mt-1 flex justify-end" />
            </Th>
            <Th className="text-right">
              All elements
              <SourceTag source="rank_absolute" className="mt-1 flex justify-end" label="live check" />
            </Th>
            <Th className="text-right">24h</Th>
            <Th className="text-right">7d</Th>
            <Th className="text-right">28d</Th>
            <Th className="text-right">
              Average position
              <SourceTag source="Search Console average" className="mt-1 flex justify-end" />
            </Th>
            <Th className="text-right">Last check</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={`${row.keywordId}-${row.keywordTargetId ?? 'none'}`}
              className="hover:bg-muted/40"
            >
              <Td className="min-w-44">
                <Link
                  href={`/p/${propertyId}/keywords/${row.keywordId}${
                    row.keywordTargetId ? `?target=${row.keywordTargetId}` : ''
                  }`}
                  className="font-medium hover:underline"
                >
                  {row.term}
                </Link>
                {row.isPrimary ? (
                  <Badge tone="outline" className="ml-2">
                    primary
                  </Badge>
                ) : null}
              </Td>

              <Td className="text-muted-foreground text-xs whitespace-nowrap">
                {row.locationName ?? 'no target'}
                {row.device ? ` · ${row.device}` : ''}
              </Td>

              <Td className="text-right tabular-nums">
                {row.found === false ? (
                  <Badge tone="critical">not found</Badge>
                ) : row.rankGroup === null ? (
                  <span className="text-muted-foreground">not checked</span>
                ) : (
                  <span className="font-medium">#{row.rankGroup}</span>
                )}
              </Td>

              <Td className="text-right tabular-nums">
                {row.rankAbsolute === null ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  <>
                    <span>#{row.rankAbsolute}</span>
                    {row.furnitureGap ? (
                      <span className="text-muted-foreground ml-1 text-xs">
                        +{row.furnitureGap}
                      </span>
                    ) : null}
                  </>
                )}
              </Td>

              <Td className="text-right">
                <Delta value={row.delta24h} />
              </Td>
              <Td className="text-right">
                <Delta value={row.delta7d} />
              </Td>
              <Td className="text-right">
                <Delta value={row.delta28d} />
              </Td>

              <Td className="text-right tabular-nums">
                {row.gscPosition === null ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  <>
                    <span className="font-medium">{formatPosition(row.gscPosition)}</span>
                    <span className="text-muted-foreground block text-[11px]">
                      {row.gscDate ? formatGscDate(row.gscDate) : ''} ·{' '}
                      {formatInteger(row.gscImpressions)} impr
                    </span>
                    {row.isLowConfidence ? (
                      <Badge tone="warning" className="mt-1">
                        under 3 impressions
                      </Badge>
                    ) : null}
                    {row.gscIsProvisional && !row.isLowConfidence ? (
                      <Badge tone="neutral" className="mt-1">
                        provisional
                      </Badge>
                    ) : null}
                  </>
                )}
              </Td>

              <Td className="text-muted-foreground text-right text-xs whitespace-nowrap">
                {relativeTime(row.checkedAt)}
                <span className="block text-[11px]">{timeZone.split('/')[1] ?? timeZone}</span>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
      </TableWrap>
    </>
  );
}

/**
 * The same rows as cards, for phone widths.
 *
 * The table scrolls horizontally rather than overflowing the page, but on a
 * 400px screen that puts every position number off the right edge behind a
 * scroll nobody discovers. The numbers are the product; they go first.
 */
function KeywordCards({
  rows,
  propertyId,
}: {
  rows: readonly KeywordRow[];
  propertyId: string;
}) {
  return (
    <ul className="divide-y sm:hidden">
      {rows.map((row) => (
        <li key={`${row.keywordId}-${row.keywordTargetId ?? 'none'}-card`} className="px-5 py-4">
          <Link
            href={`/p/${propertyId}/keywords/${row.keywordId}${
              row.keywordTargetId ? `?target=${row.keywordTargetId}` : ''
            }`}
            className="font-medium"
          >
            {row.term}
          </Link>
          {row.isPrimary ? (
            <Badge tone="outline" className="ml-2">
              primary
            </Badge>
          ) : null}
          <p className="text-muted-foreground mt-0.5 text-xs">
            {row.locationName ?? 'no target'}
            {row.device ? ` · ${row.device}` : ''} · {relativeTime(row.checkedAt)}
          </p>

          <div className="mt-3 grid grid-cols-2 gap-3">
            <div>
              <SourceTag source="live rank" />
              <p className="mt-1 text-lg font-semibold tabular-nums">
                {row.found === false ? (
                  <Badge tone="critical">not found</Badge>
                ) : row.rankGroup === null ? (
                  <span className="text-muted-foreground text-sm font-normal">not checked</span>
                ) : (
                  <>
                    #{row.rankGroup}
                    {row.rankAbsolute !== null ? (
                      <span className="text-muted-foreground ml-2 text-xs font-normal">
                        #{row.rankAbsolute} all elements
                      </span>
                    ) : null}
                  </>
                )}
              </p>
              <div className="mt-1 flex flex-wrap gap-x-3">
                <Delta value={row.delta24h} suffix="24h" />
                <Delta value={row.delta7d} suffix="7d" />
              </div>
            </div>

            <div>
              <SourceTag source="Search Console average" />
              <p className="mt-1 text-lg font-semibold tabular-nums">
                {formatPosition(row.gscPosition)}
              </p>
              {row.gscPosition !== null ? (
                <p className="text-muted-foreground text-[11px]">
                  {row.gscDate ? formatGscDate(row.gscDate) : ''} ·{' '}
                  {formatInteger(row.gscImpressions)} impr
                  {row.gscIsProvisional ? ' · provisional' : ''}
                </p>
              ) : null}
              {row.isLowConfidence ? (
                <Badge tone="warning" className="mt-1">
                  under 3 impressions
                </Badge>
              ) : null}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
