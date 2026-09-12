import { pacificToday, shiftDate, type DateString } from '@/lib/gsc-dates';
import { getGscSeries } from '@/server/ingest/gsc-read';
import type { GscSeriesPoint } from '@/server/ingest/gsc-series';
import type { PropertyScope } from '@/server/db/scoped';
import { getReconciliation, type Reconciliation } from './reconciliation';
import {
  keywordById,
  rankHistory,
  rankingUrlChanges,
  targetsForKeyword,
  type RankPoint,
  type RankingUrlChange,
} from './queries';

export interface KeywordDetail {
  keyword: { id: string; term: string; isPrimary: boolean };
  targets: Array<{
    id: string;
    locationName: string;
    locationCode: number;
    device: 'desktop' | 'mobile';
    isActive: boolean;
    lastLiveCheckAt: Date | null;
  }>;
  selectedTargetId: string | null;
  history: RankPoint[];
  urlChanges: RankingUrlChange[];
  gsc: GscSeriesPoint[];
  reconciliation: Reconciliation | null;
  from: DateString;
  to: DateString;
}

/**
 * Everything the keyword detail page renders, in one place.
 *
 * The two series are fetched through the functions that already own their
 * rules — `rankHistory` for checks, `getGscSeries` for the resolved daily
 * series — and are NOT merged here. They stay two arrays all the way to the
 * chart, because merging them into one row per "day" would require deciding
 * that a Pacific day and a property-local day are the same day, and they are
 * 12.5–13.5 hours apart.
 */
export async function keywordDetail(
  scope: PropertyScope,
  keywordId: string,
  requestedTargetId: string | null,
  days = 28,
): Promise<KeywordDetail | null> {
  const keyword = await keywordById(scope, keywordId);
  if (!keyword) return null;

  const targetRows = await targetsForKeyword(scope, keywordId);
  const targets = targetRows.map((t) => ({
    id: t.id,
    locationName: t.locationName,
    locationCode: t.locationCode,
    device: t.device,
    isActive: t.isActive,
    lastLiveCheckAt: t.lastLiveCheckAt,
  }));

  const selected =
    targets.find((t) => t.id === requestedTargetId) ?? targets.find((t) => t.isActive) ?? targets[0];

  const to = pacificToday();
  const from = shiftDate(to, -(days - 1));

  const [history, gsc] = await Promise.all([
    selected ? rankHistory(scope, selected.id, days) : Promise.resolve([]),
    getGscSeries(keywordId, from, to),
  ]);

  // Reconcile on the freshest date we actually hold a reading for. Anchoring on
  // "today" would almost always land on a hole, since Google finalises at T−3.
  const anchor = [...gsc].reverse().find((p) => p.source !== 'none' && p.position !== null);

  const reconciliation = anchor
    ? await getReconciliation(keywordId, keyword.term, anchor.date, anchor)
    : null;

  return {
    keyword: { id: keyword.id, term: keyword.term, isPrimary: keyword.isPrimary },
    targets,
    selectedTargetId: selected?.id ?? null,
    history,
    urlChanges: rankingUrlChanges(history),
    gsc,
    reconciliation,
    from,
    to,
  };
}
