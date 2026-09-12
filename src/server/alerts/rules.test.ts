import { describe, expect, it } from 'vitest';

import {
  evaluate,
  hasEnoughChecks,
  MIN_CHECKS_PER_DAY,
  RANK_DROP_THRESHOLD,
  RANK_GAIN_THRESHOLD,
  resolvedSignatures,
  signatureFor,
  TOP_N,
  type DayFacts,
  type TargetFacts,
} from './rules';

const TARGET = 'target-1';

function day(
  dayString: string,
  bestRankGroup: number | null,
  { checks = 4, found = bestRankGroup === null ? 0 : 4 } = {},
): DayFacts {
  return { day: dayString, bestRankGroup, checksCount: checks, foundCount: found };
}

function facts(overrides: Partial<TargetFacts> = {}): TargetFacts {
  return {
    keywordTargetId: TARGET,
    keywordId: 'keyword-1',
    propertyId: 'property-1',
    term: 'prestige sector 150 noida',
    locationName: 'Noida, Uttar Pradesh, India',
    device: 'mobile',
    today: day('2026-09-12', 10),
    baseline: day('2026-09-05', 10),
    baselineDays: 7,
    rankingUrlChange: null,
    newTop3Competitors: [],
    ...overrides,
  };
}

const typesOf = (f: TargetFacts) => evaluate(f).map((a) => a.type).sort();

describe('rank movement', () => {
  it('raises nothing when the rank did not move', () => {
    expect(evaluate(facts())).toEqual([]);
  });

  it('raises a drop at the threshold, not one place before it', () => {
    const under = facts({ today: day('2026-09-12', 10 + RANK_DROP_THRESHOLD - 1) });
    const at = facts({ today: day('2026-09-12', 10 + RANK_DROP_THRESHOLD) });

    expect(typesOf(under)).not.toContain('rank_drop');
    expect(typesOf(at)).toContain('rank_drop');
  });

  it('raises a gain at the threshold', () => {
    const at = facts({
      baseline: day('2026-09-05', 20),
      today: day('2026-09-12', 20 - RANK_GAIN_THRESHOLD),
    });
    expect(typesOf(at)).toContain('rank_gain');
  });

  it('escalates a very large drop to critical', () => {
    const small = evaluate(facts({ today: day('2026-09-12', 16) })).find((a) => a.type === 'rank_drop');
    const huge = evaluate(facts({ today: day('2026-09-12', 40) })).find((a) => a.type === 'rank_drop');

    expect(small?.severity).toBe('warning');
    expect(huge?.severity).toBe('critical');
  });

  it('never raises a drop and a gain at once', () => {
    for (const rank of [1, 5, 9, 10, 11, 20, 50, 99]) {
      const types = typesOf(facts({ today: day('2026-09-12', rank) }));
      expect(types.includes('rank_drop') && types.includes('rank_gain')).toBe(false);
    }
  });

  it('says nothing without a baseline rather than inventing one', () => {
    expect(evaluate(facts({ baseline: null }))).toEqual([]);
  });
});

describe('top ten', () => {
  it('fires on leaving, at the boundary', () => {
    const types = typesOf(facts({ baseline: day('2026-09-05', TOP_N), today: day('2026-09-12', TOP_N + 1) }));
    expect(types).toContain('lost_top_10');
  });

  it('fires on entering', () => {
    const types = typesOf(facts({ baseline: day('2026-09-05', TOP_N + 1), today: day('2026-09-12', TOP_N) }));
    expect(types).toContain('entered_top_10');
  });

  it('does not fire when both days are inside or both outside', () => {
    expect(typesOf(facts({ baseline: day('2026-09-05', 3), today: day('2026-09-12', 8) }))).not.toContain('lost_top_10');
    expect(typesOf(facts({ baseline: day('2026-09-05', 30), today: day('2026-09-12', 33) }))).not.toContain('entered_top_10');
  });

  /*
   * A big fall is genuinely two things a reader wants to know: the size of the
   * move and the loss of page one. Suppressing either would hide one of them.
   */
  it('raises both a drop and a top-ten loss on a big fall from inside', () => {
    const types = typesOf(facts({ baseline: day('2026-09-05', 4), today: day('2026-09-12', 40) }));
    expect(types).toContain('rank_drop');
    expect(types).toContain('lost_top_10');
  });
});

describe('lost from the index', () => {
  it('fires only when EVERY check that day found nothing', () => {
    const allMissed = facts({ today: day('2026-09-12', null, { checks: 4, found: 0 }) });
    const someFound = facts({ today: day('2026-09-12', 12, { checks: 4, found: 1 }) });

    expect(typesOf(allMissed)).toContain('lost_from_index');
    expect(typesOf(someFound)).not.toContain('lost_from_index');
  });

  it('does not fire when it was already missing on the baseline day', () => {
    const stillGone = facts({
      baseline: day('2026-09-05', null, { checks: 4, found: 0 }),
      today: day('2026-09-12', null, { checks: 4, found: 0 }),
    });
    expect(typesOf(stillGone)).not.toContain('lost_from_index');
  });

  // Domain rule 5. The alert body is where a reader would most easily
  // misremember this, so it says it out loud.
  it('says in words that this is not position 100', () => {
    const alert = evaluate(facts({ today: day('2026-09-12', null, { checks: 4, found: 0 }) }))
      .find((a) => a.type === 'lost_from_index');
    expect(alert?.body).toMatch(/never as position 100/);
    expect(alert?.severity).toBe('critical');
  });
});

describe('events independent of rank', () => {
  it('raises a ranking URL change even when the position did not move', () => {
    const types = typesOf(facts({ rankingUrlChange: { from: '/a', to: '/b' } }));
    expect(types).toEqual(['ranking_url_changed']);
  });

  it('raises one alert per new top-3 competitor', () => {
    const alerts = evaluate(facts({ newTop3Competitors: ['a.com', 'b.com'] }));
    expect(alerts.map((a) => a.type)).toEqual(['new_competitor_top_3', 'new_competitor_top_3']);
    expect(new Set(alerts.map((a) => a.signature)).size).toBe(2);
  });
});

describe('the minimum-checks gate', () => {
  /*
   * §9: baselines never come from a single check. A rollup built from one check
   * IS that check, so reading a rollup does not by itself satisfy the rule.
   */
  it('says nothing when today rests on fewer than the minimum checks', () => {
    const thin = facts({
      today: day('2026-09-12', null, { checks: MIN_CHECKS_PER_DAY - 1, found: 0 }),
    });
    expect(hasEnoughChecks(thin)).toBe(false);
    expect(evaluate(thin)).toEqual([]);
  });

  it('says nothing when the baseline rests on fewer than the minimum checks', () => {
    const thin = facts({
      baseline: day('2026-09-05', 3, { checks: MIN_CHECKS_PER_DAY - 1, found: 1 }),
      today: day('2026-09-12', 40),
    });
    expect(hasEnoughChecks(thin)).toBe(false);
    expect(evaluate(thin)).toEqual([]);
  });

  it('allows a first evaluation with no baseline at all', () => {
    expect(hasEnoughChecks(facts({ baseline: null }))).toBe(true);
  });

  /*
   * The gate covers resolving as well. A day we cannot judge is not evidence a
   * condition cleared, and auto-resolving on it would free the signature — so
   * one ongoing problem would re-alert every time a thin day came round.
   */
  it('resolves nothing on a day it cannot judge', () => {
    const thin = facts({ today: day('2026-09-12', 3, { checks: 1, found: 1 }) });
    expect(resolvedSignatures(thin)).toEqual([]);
  });
});

describe('signatures', () => {
  it('is stable for the same condition, so a persisting problem alerts once', () => {
    const a = evaluate(facts({ baseline: day('2026-09-05', 5), today: day('2026-09-12', 15) }));
    const b = evaluate(facts({ baseline: day('2026-09-06', 5), today: day('2026-09-13', 15) }));

    expect(a.map((x) => x.signature)).toEqual(b.map((x) => x.signature));
  });

  it('changes when the move starts from a different place, so a second fall alerts again', () => {
    const first = evaluate(facts({ baseline: day('2026-09-05', 5), today: day('2026-09-12', 15) }))
      .find((x) => x.type === 'rank_drop');
    const second = evaluate(facts({ baseline: day('2026-09-12', 15), today: day('2026-09-19', 40) }))
      .find((x) => x.type === 'rank_drop');

    expect(first?.signature).not.toBe(second?.signature);
  });

  it('never collides across types or targets', () => {
    const seen = new Set<string>();
    for (const type of ['rank_drop', 'rank_gain', 'lost_top_10', 'entered_top_10'] as const) {
      for (const target of ['a', 'b']) {
        for (const bucket of ['', '5', '15']) {
          seen.add(signatureFor(type, target, bucket));
        }
      }
    }
    expect(seen.size).toBe(4 * 2 * 3);
  });

  it('is a hex digest, not the inputs', () => {
    const signature = signatureFor('rank_drop', TARGET, '5');
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
    expect(signature).not.toContain(TARGET);
  });
});

describe('every candidate', () => {
  const all = [
    ...evaluate(facts({ baseline: day('2026-09-05', 4), today: day('2026-09-12', 40) })),
    ...evaluate(facts({ baseline: day('2026-09-05', 30), today: day('2026-09-12', 4) })),
    ...evaluate(facts({ today: day('2026-09-12', null, { checks: 4, found: 0 }) })),
    ...evaluate(facts({ rankingUrlChange: { from: '/a', to: '/b' } })),
    ...evaluate(facts({ newTop3Competitors: ['rival.com'] })),
  ];

  it('records the day it was judged on, so an older re-run cannot resolve it', () => {
    expect(all.length).toBeGreaterThan(5);
    for (const alert of all) expect(alert.payload.day).toBe('2026-09-12');
  });

  it('names the keyword in the title', () => {
    for (const alert of all) expect(alert.title).toContain('prestige sector 150 noida');
  });

  /*
   * Acceptance criterion 7 does not stop at the dashboard. An alert body with a
   * bare "#14" invites the reader to compare it with a Search Console figure,
   * which is the one thing this product exists to prevent.
   */
  it('never quotes a position without saying what kind it is', () => {
    for (const alert of all) {
      if (!/#\d/.test(alert.body)) continue;
      expect(alert.body).toMatch(/organic rank|ranked at #|rank_group|top 10|top \d/i);
    }
  });

  it('carries a location and a device, because a rank is meaningless without them', () => {
    for (const alert of all) {
      expect(alert.body).toContain('Noida, Uttar Pradesh, India');
      expect(alert.body).toContain('mobile');
    }
  });
});
