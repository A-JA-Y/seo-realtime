import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import { shiftDate, type DateString } from '@/lib/gsc-dates';
import type { Logger } from '@/lib/logger';
import { db } from '@/server/db';
import { alerts } from '@/server/db/schema';
import { withIngestRun } from '@/server/ingest/runs';
import {
  evaluate,
  evaluateIngest,
  resolvedIngestSignatures,
  resolvedSignatures,
  type AlertCandidate,
  type DayFacts,
  type IngestFacts,
  type TargetFacts,
} from './rules';

/**
 * The alert engine (§9).
 *
 * In-app only. There is no email, no Slack, no webhook — that is a product
 * decision, not an unfinished one, and adding a delivery channel later means
 * reading the `alerts` table, never changing this file.
 *
 * Everything here is a gather step feeding the pure rules in `rules.ts`. The
 * SQL knows nothing about thresholds and the rules know nothing about the
 * database, so a threshold change never needs a migration and a query change
 * never silently alters what fires.
 */

/** How far back the baseline sits. §9 compares against a rollup, never a check. */
export const BASELINE_DAYS = 7;

export interface AlertRunResult {
  propertyId: string;
  day: DateString;
  targetsEvaluated: number;
  raised: number;
  suppressed: number;
  resolved: number;
}

interface FactRow extends Record<string, unknown> {
  keyword_target_id: string;
  keyword_id: string;
  property_id: string;
  term: string;
  location_name: string;
  device: 'desktop' | 'mobile';
  today_day: string | null;
  today_best: number | null;
  today_checks: number | null;
  today_found: number | null;
  base_day: string | null;
  base_best: number | null;
  base_checks: number | null;
  base_found: number | null;
}

/**
 * Evaluate every active target of one property and write what fires.
 *
 * The rollup day is the PROPERTY's day, matching `daily_rank_rollups`. It is
 * deliberately not the Pacific day: a client's "today" is their own, and §9's
 * baselines come from rollups, which are bucketed that way.
 */
export async function runAlertsForProperty(
  propertyId: string,
  options: { day?: DateString; logger?: Logger } = {},
): Promise<AlertRunResult> {
  const outcome = await withIngestRun(
    { kind: 'alerts', propertyId, ...(options.logger ? { logger: options.logger } : {}) },
    async (run) => {
      // The rollup for "today" is only complete once the day is over, so the
      // engine evaluates the most recent day that HAS a rollup rather than a
      // partial one. `pacificToday` is not used here — see the note above.
      const day = options.day ?? (await latestRollupDay(propertyId));
      if (!day) {
        run.setMeta({ reason: 'no rollups yet' });
        return { propertyId, day: '', targetsEvaluated: 0, raised: 0, suppressed: 0, resolved: 0 };
      }

      const baselineDay = shiftDate(day, -BASELINE_DAYS);
      const facts = await gatherFacts(propertyId, day, baselineDay);

      const candidates: AlertCandidate[] = [];
      const clearable: string[] = [];

      for (const target of facts) {
        candidates.push(...evaluate(target));
        clearable.push(...resolvedSignatures(target));
      }

      /*
       * The property-level arm. Everything above needs rollups to exist; this
       * one fires precisely when they have STOPPED existing, so it must not be
       * gated on the same facts — a property whose ingest died has no fresh
       * rollups to evaluate, which is exactly when the per-target loop above
       * goes quiet and says nothing.
       */
      const ingest = await ingestFacts(propertyId);
      if (ingest) {
        candidates.push(...evaluateIngest(ingest, day));
        clearable.push(...resolvedIngestSignatures(ingest));
      }

      const resolved = await resolveCleared(propertyId, clearable, day);
      const { raised, suppressed } = await raise(candidates);

      run.addRows(raised);
      run.setMeta({
        day,
        baseline_day: baselineDay,
        targets: facts.length,
        candidates: candidates.length,
        raised,
        suppressed,
        resolved,
      });

      return {
        propertyId,
        day,
        targetsEvaluated: facts.length,
        raised,
        suppressed,
        resolved,
      };
    },
  );

  return outcome.result;
}

/**
 * How long this property has been silent on each source.
 *
 * Null means nothing has ever arrived, which the rule treats as "not yet
 * started" rather than "died" — see `evaluateIngest`.
 */
async function ingestFacts(propertyId: string): Promise<IngestFacts | null> {
  const result = await db.execute<{
    name: string;
    gsc_hours: string | null;
    serp_hours: string | null;
  }>(sql`
    SELECT
      p.name,
      EXTRACT(EPOCH FROM (now() - (
        SELECT max(g.fetched_at) FROM gsc_snapshots g WHERE g.property_id = p.id
      ))) / 3600 AS gsc_hours,
      EXTRACT(EPOCH FROM (now() - (
        SELECT max(s.checked_at) FROM serp_checks s WHERE s.property_id = p.id
      ))) / 3600 AS serp_hours
    FROM properties p
    WHERE p.id = ${propertyId} AND p.is_active
  `);

  const row = result.rows[0];
  if (!row) return null;

  return {
    propertyId,
    propertyName: row.name,
    hoursSinceGscRow: row.gsc_hours === null ? null : Number(row.gsc_hours),
    hoursSinceSerpCheck: row.serp_hours === null ? null : Number(row.serp_hours),
  };
}

/**
 * The most recent day this property has a rollup for.
 *
 * No clock. A rollup is built from checks that have already happened, so its
 * maximum day cannot be in the future, and a `now` parameter that the query
 * then ignored would be a broken injection point pretending to be a real one.
 * Tests pin the day with `options.day` instead.
 */
async function latestRollupDay(propertyId: string): Promise<DateString | null> {
  const result = await db.execute<{ day: string | null }>(sql`
    SELECT to_char(MAX(r.day), 'YYYY-MM-DD') AS day
    FROM daily_rank_rollups r
    JOIN keyword_targets kt ON kt.id = r.keyword_target_id
    WHERE kt.property_id = ${propertyId}
  `);

  return result.rows[0]?.day ?? null;
}

/**
 * One query for both days, plus the two event signals.
 *
 * The URL change and the new-competitor check read `serp_checks` rather than
 * the rollups, because neither is an aggregate — a rollup has no room for
 * "which URL" or "who else was there".
 */
async function gatherFacts(
  propertyId: string,
  day: DateString,
  baselineDay: DateString,
): Promise<TargetFacts[]> {
  const result = await db.execute<FactRow>(sql`
    SELECT
      kt.id AS keyword_target_id, kt.keyword_id, kt.property_id,
      k.term, kt.location_name, kt.device,
      to_char(t.day, 'YYYY-MM-DD') AS today_day,
      t.best_rank_group AS today_best, t.checks_count AS today_checks, t.found_count AS today_found,
      to_char(b.day, 'YYYY-MM-DD') AS base_day,
      b.best_rank_group AS base_best, b.checks_count AS base_checks, b.found_count AS base_found
    FROM keyword_targets kt
    JOIN keywords k ON k.id = kt.keyword_id
    LEFT JOIN daily_rank_rollups t ON t.keyword_target_id = kt.id AND t.day = ${day}::date
    LEFT JOIN daily_rank_rollups b ON b.keyword_target_id = kt.id AND b.day = ${baselineDay}::date
    WHERE kt.property_id = ${propertyId} AND kt.is_active AND k.is_active
  `);

  const targetIds = result.rows.map((r) => r.keyword_target_id);
  const [urlChanges, newCompetitors] = await Promise.all([
    rankingUrlChanges(targetIds, day, baselineDay),
    newTop3Competitors(targetIds, day, baselineDay),
  ]);

  return result.rows
    .filter((row) => row.today_day !== null)
    .map((row) => ({
      keywordTargetId: row.keyword_target_id,
      keywordId: row.keyword_id,
      propertyId: row.property_id,
      term: row.term,
      locationName: row.location_name,
      device: row.device,
      today: toDayFacts(row.today_day, row.today_best, row.today_checks, row.today_found)!,
      baseline: toDayFacts(row.base_day, row.base_best, row.base_checks, row.base_found),
      baselineDays: BASELINE_DAYS,
      rankingUrlChange: urlChanges.get(row.keyword_target_id) ?? null,
      newTop3Competitors: newCompetitors.get(row.keyword_target_id) ?? [],
    }));
}

function toDayFacts(
  day: string | null,
  best: number | null,
  checks: number | null,
  found: number | null,
): DayFacts | null {
  if (day === null) return null;
  return { day, bestRankGroup: best, checksCount: checks ?? 0, foundCount: found ?? 0 };
}

/**
 * The ranking URL on the latest FOUND check of each day, where they differ.
 *
 * Only found checks are considered: a not-found check has no ranking URL, and
 * treating that as a swap reports dropping out of the results as a page
 * preference change — a different event with a different cause.
 */
async function rankingUrlChanges(
  targetIds: readonly string[],
  day: DateString,
  baselineDay: DateString,
): Promise<Map<string, { from: string; to: string }>> {
  const changes = new Map<string, { from: string; to: string }>();
  if (targetIds.length === 0) return changes;

  const result = await db.execute<{
    keyword_target_id: string;
    from_url: string | null;
    to_url: string | null;
  }>(sql`
    WITH latest_on AS (
      SELECT DISTINCT ON (sc.keyword_target_id, (sc.checked_at AT TIME ZONE p.timezone)::date)
        sc.keyword_target_id,
        (sc.checked_at AT TIME ZONE p.timezone)::date AS day,
        sc.ranking_url
      FROM serp_checks sc
      JOIN properties p ON p.id = sc.property_id
      WHERE sc.keyword_target_id IN ${targetIds}
        AND sc.found
        AND sc.ranking_url IS NOT NULL
        AND (sc.checked_at AT TIME ZONE p.timezone)::date IN (${day}::date, ${baselineDay}::date)
      ORDER BY sc.keyword_target_id, (sc.checked_at AT TIME ZONE p.timezone)::date, sc.checked_at DESC
    )
    SELECT
      t.keyword_target_id,
      b.ranking_url AS from_url,
      t.ranking_url AS to_url
    FROM latest_on t
    JOIN latest_on b ON b.keyword_target_id = t.keyword_target_id AND b.day = ${baselineDay}::date
    WHERE t.day = ${day}::date AND t.ranking_url IS DISTINCT FROM b.ranking_url
  `);

  for (const row of result.rows) {
    if (row.from_url && row.to_url) {
      changes.set(row.keyword_target_id, { from: row.from_url, to: row.to_url });
    }
  }

  return changes;
}

/** Domains in the top 3 today that were not in the top 3 on the baseline day. */
async function newTop3Competitors(
  targetIds: readonly string[],
  day: DateString,
  baselineDay: DateString,
): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();
  if (targetIds.length === 0) return found;

  const result = await db.execute<{ keyword_target_id: string; domain: string }>(sql`
    WITH latest_on AS (
      SELECT DISTINCT ON (sc.keyword_target_id, (sc.checked_at AT TIME ZONE p.timezone)::date)
        sc.keyword_target_id,
        (sc.checked_at AT TIME ZONE p.timezone)::date AS day,
        sc.competing_domains
      FROM serp_checks sc
      JOIN properties p ON p.id = sc.property_id
      WHERE sc.keyword_target_id IN ${targetIds}
        AND (sc.checked_at AT TIME ZONE p.timezone)::date IN (${day}::date, ${baselineDay}::date)
      ORDER BY sc.keyword_target_id, (sc.checked_at AT TIME ZONE p.timezone)::date, sc.checked_at DESC
    ),
    top3 AS (
      SELECT
        l.keyword_target_id,
        l.day,
        (c->>'domain')::text AS domain
      FROM latest_on l
      CROSS JOIN LATERAL jsonb_array_elements(l.competing_domains) AS c
      WHERE (c->>'rank_group')::int <= 3 AND c->>'domain' IS NOT NULL
    )
    SELECT DISTINCT t.keyword_target_id, t.domain
    FROM top3 t
    WHERE t.day = ${day}::date
      AND EXISTS (
        SELECT 1 FROM top3 b
        WHERE b.keyword_target_id = t.keyword_target_id AND b.day = ${baselineDay}::date
      )
      AND NOT EXISTS (
        SELECT 1 FROM top3 b
        WHERE b.keyword_target_id = t.keyword_target_id
          AND b.day = ${baselineDay}::date
          AND b.domain = t.domain
      )
  `);

  for (const row of result.rows) {
    const bucket = found.get(row.keyword_target_id);
    if (bucket) bucket.push(row.domain);
    else found.set(row.keyword_target_id, [row.domain]);
  }

  return found;
}

/**
 * Write the candidates, letting the partial unique index do the suppression.
 *
 * `ON CONFLICT DO NOTHING` against `alerts_open_signature` means re-raising an
 * open condition costs one no-op insert and changes nothing — no read-then-act
 * check, so two concurrent runs cannot both decide the alert is new.
 *
 * `RETURNING id` tells us which rows actually landed, which is the difference
 * between "raised 3" and "raised 0, the same 3 as yesterday".
 */
async function raise(candidates: readonly AlertCandidate[]): Promise<{
  raised: number;
  suppressed: number;
}> {
  if (candidates.length === 0) return { raised: 0, suppressed: 0 };

  // Two candidates in one batch can share a signature — the same competitor
  // entering the top 3 for two targets of one keyword, say. The index would
  // reject the second inside a single statement, so collapse them first.
  const unique = new Map<string, AlertCandidate>();
  for (const candidate of candidates) unique.set(candidate.signature, candidate);

  const inserted = await db
    .insert(alerts)
    .values(
      [...unique.values()].map((candidate) => ({
        propertyId: candidate.propertyId,
        keywordId: candidate.keywordId,
        keywordTargetId: candidate.keywordTargetId,
        type: candidate.type,
        severity: candidate.severity,
        title: candidate.title,
        body: candidate.body,
        payload: candidate.payload,
        signature: candidate.signature,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: alerts.id });

  return { raised: inserted.length, suppressed: candidates.length - inserted.length };
}

/**
 * Close the open alerts whose condition no longer holds.
 *
 * Only alerts raised from a day at or before this one. Without that guard, a
 * backfill or a manual re-run of an older day resolves alerts raised from newer
 * data — freeing their signatures, so the next forward run raises the same
 * conditions again as if they were new. An ongoing problem then arrives as a
 * fresh notification every time anyone re-runs an old day.
 */
async function resolveCleared(
  propertyId: string,
  signatures: readonly string[],
  day: DateString,
): Promise<number> {
  if (signatures.length === 0) return 0;

  const updated = await db
    .update(alerts)
    .set({ resolvedAt: sql`now()` })
    .where(
      and(
        eq(alerts.propertyId, propertyId),
        isNull(alerts.resolvedAt),
        inArray(alerts.signature, [...signatures]),
        sql`(${alerts.payload}->>'day')::date <= ${day}::date`,
      ),
    )
    .returning({ id: alerts.id });

  return updated.length;
}
