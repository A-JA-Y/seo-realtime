import { createHash } from 'node:crypto';

import type { AlertSeverity, AlertType } from '@/server/db/schema';

/**
 * The alert rules (§9).
 *
 * Pure. Every function here takes a day's facts and returns candidates; nothing
 * reads a database or a clock. That is what lets the thresholds, the severities
 * and — most importantly — the SIGNATURE be tested exhaustively, because the
 * signature is what decides whether a condition that persists for a fortnight
 * raises one alert or fourteen.
 */

/** §9: a single check is too noisy to alert on. Baselines are rollup values. */
export interface TargetFacts {
  keywordTargetId: string;
  keywordId: string;
  propertyId: string;
  term: string;
  locationName: string;
  device: 'desktop' | 'mobile';

  /** Today's rollup. Null rank means every check that day found nothing. */
  today: DayFacts;
  /** The comparison day's rollup, or null when there is no baseline. */
  baseline: DayFacts | null;
  /** How many days back the baseline is. Named in the alert body. */
  baselineDays: number;

  /** The ranking URL swap detected across the window, if any. */
  rankingUrlChange: { from: string; to: string } | null;
  /** Domains newly in the top 3 that were not there on the baseline day. */
  newTop3Competitors: string[];
}

export interface DayFacts {
  day: string;
  bestRankGroup: number | null;
  checksCount: number;
  foundCount: number;
}

export interface AlertCandidate {
  type: AlertType;
  severity: AlertSeverity;
  title: string;
  body: string;
  signature: string;
  keywordId: string | null;
  keywordTargetId: string | null;
  propertyId: string;
  /**
   * Always carries `day`: the rollup day this was judged on.
   *
   * Not decoration. `created_at` is wall-clock time, which says when the job
   * ran, not which day's data it read — and those differ on a backfill or a
   * manual re-run. Resolution keys off this, so an older day cannot close an
   * alert raised from a newer one.
   */
  payload: Record<string, unknown> & { day: string };
}

/** §9: "a move of this size is worth a person's attention". */
export const RANK_DROP_THRESHOLD = 5;
export const RANK_GAIN_THRESHOLD = 5;
export const TOP_N = 10;

/**
 * Neither side of a comparison may rest on a single check (§9).
 *
 * A rollup built from one check IS that check, so "baselines come from
 * daily_rank_rollups, never a single check" is not satisfied by reading a
 * rollup — it is satisfied by reading a rollup that aggregated something. The
 * day a property is onboarded, and the current day before its second check, are
 * both one-check days, and a SERP that flickers once would otherwise raise a
 * critical "no longer in the results".
 *
 * Two is the smallest number that is not one. Raising it trades alert latency
 * for confidence; at four checks a day, two is about six hours.
 */
export const MIN_CHECKS_PER_DAY = 2;

/**
 * `sha256(type + keyword_target_id + bucket)` (§9).
 *
 * The bucket is what keeps a condition that persists from re-alerting daily.
 * The partial unique index (`signature WHERE resolved_at IS NULL`) turns a
 * repeat into a no-op insert, so the bucket only has to be STABLE for as long
 * as the condition is the same one — and to CHANGE when it is genuinely a new
 * one.
 *
 * So the bucket is never a date. For a state (out of the top 10, gone from the
 * index) it is empty, because there is only one way to be in that state. For a
 * move it is the position moved FROM, so 5 → 15 and a later 15 → 40 are two
 * alerts while re-detecting the same 5 → 15 every day is one. For an event it
 * is the thing that happened — the new URL, the competitor's domain.
 */
export function signatureFor(type: AlertType, keywordTargetId: string | null, bucket: string): string {
  return createHash('sha256')
    .update(`${type}:${keywordTargetId ?? 'property'}:${bucket}`)
    .digest('hex');
}

const where = (f: TargetFacts) => `${f.locationName} on ${f.device}`;

/**
 * Every alert this day's facts justify.
 *
 * Order matters only for readability. A day can legitimately raise several —
 * falling from #8 to #40 is both a rank drop and a loss of the top 10, and
 * suppressing one would hide a distinct thing a reader wants to know.
 */
export function evaluate(facts: TargetFacts): AlertCandidate[] {
  const alerts: AlertCandidate[] = [];
  const { today, baseline } = facts;

  if (!hasEnoughChecks(facts)) return alerts;

  const base = {
    propertyId: facts.propertyId,
    keywordId: facts.keywordId,
    keywordTargetId: facts.keywordTargetId,
  };
  const day = today.day;

  /*
   * Gone from the results entirely.
   *
   * Requires that EVERY check that day found nothing, not just the latest one.
   * A single miss is exactly the noise §9 says not to alert on, and a SERP that
   * flickers is common.
   */
  const goneToday = today.checksCount > 0 && today.foundCount === 0;
  const wasFound = baseline !== null && baseline.foundCount > 0;

  if (goneToday && wasFound) {
    alerts.push({
      ...base,
      type: 'lost_from_index',
      severity: 'critical',
      title: `"${facts.term}" is no longer in the results`,
      body:
        `Every check on ${today.day} (${today.checksCount} of them) failed to find the domain, ` +
        `${where(facts)}. ${facts.baselineDays} days ago it ranked at #${baseline.bestRankGroup}. ` +
        `This is recorded as "not found" with no position — never as position 100.`,
      signature: signatureFor('lost_from_index', facts.keywordTargetId, ''),
      payload: { day, baselineDay: baseline.day, baselineRank: baseline.bestRankGroup },
    });
  }

  const now = today.bestRankGroup;
  const then = baseline?.bestRankGroup ?? null;

  if (now !== null && then !== null) {
    const delta = now - then;

    if (delta >= RANK_DROP_THRESHOLD) {
      alerts.push({
        ...base,
        type: 'rank_drop',
        severity: delta >= 20 ? 'critical' : 'warning',
        title: `"${facts.term}" fell ${delta} places`,
        body:
          `Best organic rank went from #${then} to #${now} over ${facts.baselineDays} days, ` +
          `${where(facts)}. Both figures are the best rank_group of that day's checks — ` +
          `not a single check, and not a Search Console average.`,
        signature: signatureFor('rank_drop', facts.keywordTargetId, String(then)),
        payload: { day, from: then, to: now, delta, days: facts.baselineDays },
      });
    }

    if (-delta >= RANK_GAIN_THRESHOLD) {
      alerts.push({
        ...base,
        type: 'rank_gain',
        severity: 'info',
        title: `"${facts.term}" gained ${-delta} places`,
        body:
          `Best organic rank went from #${then} to #${now} over ${facts.baselineDays} days, ` +
          `${where(facts)}.`,
        signature: signatureFor('rank_gain', facts.keywordTargetId, String(then)),
        payload: { day, from: then, to: now, delta, days: facts.baselineDays },
      });
    }

    if (then <= TOP_N && now > TOP_N) {
      alerts.push({
        ...base,
        type: 'lost_top_10',
        severity: 'warning',
        title: `"${facts.term}" dropped out of the top ${TOP_N}`,
        body:
          `Best organic rank went from #${then} to #${now}, ${where(facts)}. Page-one ` +
          `traffic falls off a cliff below ${TOP_N}.`,
        signature: signatureFor('lost_top_10', facts.keywordTargetId, ''),
        payload: { day, from: then, to: now },
      });
    }

    if (then > TOP_N && now <= TOP_N) {
      alerts.push({
        ...base,
        type: 'entered_top_10',
        severity: 'info',
        title: `"${facts.term}" reached the top ${TOP_N}`,
        body: `Best organic rank went from #${then} to #${now}, ${where(facts)}.`,
        signature: signatureFor('entered_top_10', facts.keywordTargetId, ''),
        payload: { day, from: then, to: now },
      });
    }
  }

  /*
   * Domain rule 7. A stable position with a changed ranking URL is a notable
   * event, not a non-event — so this fires on its own, independent of whether
   * the rank moved at all.
   */
  if (facts.rankingUrlChange) {
    const { from, to } = facts.rankingUrlChange;
    alerts.push({
      ...base,
      type: 'ranking_url_changed',
      severity: 'warning',
      title: `Google swapped the ranking page for "${facts.term}"`,
      body:
        `The page ranking organically changed from ${from} to ${to}, ${where(facts)}. ` +
        `The position may be unchanged; which of your pages Google prefers is not.`,
      signature: signatureFor('ranking_url_changed', facts.keywordTargetId, to),
      payload: { day, from, to },
    });
  }

  for (const domain of facts.newTop3Competitors) {
    alerts.push({
      ...base,
      type: 'new_competitor_top_3',
      severity: 'info',
      title: `${domain} entered the top 3 for "${facts.term}"`,
      body: `${domain} was not in the top 3 ${facts.baselineDays} days ago, ${where(facts)}.`,
      signature: signatureFor('new_competitor_top_3', facts.keywordTargetId, domain),
      payload: { domain, day },
    });
  }

  return alerts;
}

/**
 * Whether both days aggregated enough checks to say anything.
 *
 * Gates raising AND resolving. A day we cannot judge is not evidence that a
 * condition cleared, and auto-resolving on it would free the signature and let
 * the same alert fire again the moment a real day arrived — turning one
 * ongoing problem into a daily notification.
 */
export function hasEnoughChecks(facts: TargetFacts): boolean {
  if (facts.today.checksCount < MIN_CHECKS_PER_DAY) return false;
  if (facts.baseline === null) return true;
  return facts.baseline.checksCount >= MIN_CHECKS_PER_DAY;
}

/**
 * Signatures whose condition has CLEARED, so their open alert can be resolved.
 *
 * Resolving is not cosmetic: the partial unique index means an open alert holds
 * its signature, so a recurrence cannot raise a fresh one until the first is
 * resolved. An engine that only ever opened alerts would fire each condition
 * exactly once, for ever.
 */
export function resolvedSignatures(facts: TargetFacts): string[] {
  const cleared: string[] = [];
  if (!hasEnoughChecks(facts)) return cleared;

  const now = facts.today.bestRankGroup;
  const foundToday = facts.today.foundCount > 0;

  if (foundToday) {
    cleared.push(signatureFor('lost_from_index', facts.keywordTargetId, ''));
  }

  if (now !== null && now <= TOP_N) {
    cleared.push(signatureFor('lost_top_10', facts.keywordTargetId, ''));
  }

  if (now !== null && now > TOP_N) {
    cleared.push(signatureFor('entered_top_10', facts.keywordTargetId, ''));
  }

  return cleared;
}
