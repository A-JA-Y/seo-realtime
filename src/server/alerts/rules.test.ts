import { describe, expect, it } from 'vitest';

import {
  evaluate,
  hasEnoughChecks,
  MIN_CHECKS_PER_DAY,
  RANK_DROP_THRESHOLD,
  RANK_GAIN_THRESHOLD,
  RANK_MOVE_CLEAR_THRESHOLD,
  evaluateIngest,
  resolvedIngestSignatures,
  GSC_SILENCE_HOURS,
  type IngestFacts,
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

  /*
   * The regression that cost this design its point.
   *
   * The move bucket used to be the position moved FROM, so that 5 → 15 and a
   * later 15 → 40 would be two alerts. But the baseline is a SEVEN-DAY SLIDING
   * WINDOW — it advances daily — so for any keyword that is actually trending
   * the "from" value changes every day and the signature changed with it. A
   * single steady climb in the demo data raised on 22 consecutive days across
   * 18 distinct buckets.
   */
  it('holds ONE signature across a trend, however the sliding baseline moves', () => {
    // A keyword sliding steadily: the baseline it is compared against moves
    // every day, and so does the current rank.
    const slide = [
      [10, 20],
      [12, 24],
      [15, 28],
      [18, 33],
      [22, 40],
    ] as const;

    const signatures = slide.map(([from, to]) => {
      const [alert] = evaluate(
        facts({ baseline: day('2026-09-05', from), today: day('2026-09-12', to) }),
      ).filter((a) => a.type === 'rank_drop');
      expect(alert, `no rank_drop for ${from} -> ${to}`).toBeDefined();
      return alert!.signature;
    });

    expect(new Set(signatures).size, 'one episode must be one signature').toBe(1);
  });

  it('a second fall alerts again only because the first episode was resolved', () => {
    // While the drop holds, nothing clears it.
    const falling = facts({ baseline: day('2026-09-05', 5), today: day('2026-09-12', 15) });
    const drop = evaluate(falling).find((a) => a.type === 'rank_drop')!;
    expect(resolvedSignatures(falling)).not.toContain(drop.signature);

    // Recovered — the move no longer meets the threshold, so the episode ends
    // and the signature is freed.
    const recovered = facts({ baseline: day('2026-09-12', 15), today: day('2026-09-19', 16) });
    expect(resolvedSignatures(recovered)).toContain(drop.signature);

    // A later, separate fall reuses that signature, which is now free.
    const fallsAgain = facts({ baseline: day('2026-09-19', 16), today: day('2026-09-26', 45) });
    const second = evaluate(fallsAgain).find((a) => a.type === 'rank_drop')!;
    expect(second.signature).toBe(drop.signature);
    expect(resolvedSignatures(fallsAgain)).not.toContain(second.signature);
  });

  it('never resolves an episode that still holds', () => {
    for (const [from, to] of [
      [5, 15],
      [10, 30],
      [1, 99],
    ] as const) {
      const f = facts({ baseline: day('2026-09-05', from), today: day('2026-09-12', to) });
      const drop = evaluate(f).find((a) => a.type === 'rank_drop')!;
      expect(resolvedSignatures(f)).not.toContain(drop.signature);
    }
  });

  it('a gain episode resolves when the gain stops holding, and not before', () => {
    const rising = facts({ baseline: day('2026-09-05', 20), today: day('2026-09-12', 10) });
    const gain = evaluate(rising).find((a) => a.type === 'rank_gain')!;
    expect(resolvedSignatures(rising)).not.toContain(gain.signature);

    const levelled = facts({ baseline: day('2026-09-12', 10), today: day('2026-09-19', 9) });
    expect(resolvedSignatures(levelled)).toContain(gain.signature);
  });

  /*
   * The hysteresis invariant. If these ever met, the boundary would become a
   * hair trigger and one slow trend would alternate raise/resolve for ever —
   * six alerts for one climb, measured on the demo data.
   */
  it('clears a move at a strictly lower bar than it raises one', () => {
    expect(RANK_MOVE_CLEAR_THRESHOLD).toBeLessThan(RANK_DROP_THRESHOLD);
    expect(RANK_MOVE_CLEAR_THRESHOLD).toBeLessThan(RANK_GAIN_THRESHOLD);
  });

  it('does not flap while a move decays through the raise threshold', () => {
    // The real shape from the demo data: a steady climb whose gap against the
    // sliding baseline wanders either side of 5.
    const gaps = [5, 3, 5, 4, 5, 4, 4, 4, 5, 4, 3, 4, 3, 3, 4, 4, 4, 5, 4, 4, 6, 4];
    let open = false;
    let raises = 0;

    for (const gap of gaps) {
      const f = facts({ baseline: day('2026-09-05', 40), today: day('2026-09-12', 40 - gap) });
      const raised = evaluate(f).some((a) => a.type === 'rank_gain');
      const cleared = resolvedSignatures(f).includes(
        signatureFor('rank_gain', TARGET, ''),
      );

      if (!open && raised) { open = true; raises++; }
      else if (open && cleared) open = false;
    }

    // One episode, not one per threshold crossing.
    expect(raises).toBe(1);
    expect(open, 'a move that never decayed below the clear bar stays open').toBe(true);
  });

  it('a drop and a gain are never open at the same time', () => {
    // Whichever holds, the other one is being cleared.
    for (const [from, to] of [
      [5, 20],
      [20, 5],
      [10, 10],
    ] as const) {
      const f = facts({ baseline: day('2026-09-05', from), today: day('2026-09-12', to) });
      const raised = new Set(evaluate(f).map((a) => a.signature));
      const cleared = new Set(resolvedSignatures(f));
      for (const sig of raised) expect(cleared.has(sig)).toBe(false);
    }
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

describe('ingest failure', () => {
  const ingest = (over: Partial<IngestFacts> = {}): IngestFacts => ({
    propertyId: 'property-1',
    propertyName: 'Prestige Noida',
    hoursSinceGscRow: 1,
    hoursSinceSerpCheck: 1,
    ...over,
  });

  it('raises nothing while both sources are flowing', () => {
    expect(evaluateIngest(ingest(), '2026-09-12')).toEqual([]);
  });

  /*
   * The failure mode the whole system is least able to notice. A job that stops
   * running raises no error — it produces an absence, and this type existed in
   * the schema and the UI with nothing producing it.
   */
  it('raises when Search Console has gone silent', () => {
    const [alert] = evaluateIngest(
      ingest({ hoursSinceGscRow: GSC_SILENCE_HOURS + 1 }),
      '2026-09-12',
    );

    expect(alert?.type).toBe('ingest_failure');
    expect(alert?.severity).toBe('critical');
    expect(alert?.keywordId).toBeNull();
    expect(alert?.keywordTargetId).toBeNull();
    expect(alert?.title).toContain('Prestige Noida');
  });

  it('raises separately for each source, because they fail for different reasons', () => {
    const alerts = evaluateIngest(
      ingest({ hoursSinceGscRow: 100, hoursSinceSerpCheck: 100 }),
      '2026-09-12',
    );

    expect(alerts).toHaveLength(2);
    expect(new Set(alerts.map((a) => a.signature)).size).toBe(2);
  });

  it('never confuses two properties', () => {
    const a = evaluateIngest(ingest({ hoursSinceGscRow: 100 }), '2026-09-12')[0]!;
    const b = evaluateIngest(
      ingest({ propertyId: 'property-2', hoursSinceGscRow: 100 }),
      '2026-09-12',
    )[0]!;

    expect(a.signature).not.toBe(b.signature);
  });

  /*
   * Death, not birth. A property added an hour ago has no rows and is not
   * broken; alerting on it would fire on every onboarding.
   */
  it('says nothing about a property that has never ingested anything', () => {
    expect(
      evaluateIngest(ingest({ hoursSinceGscRow: null, hoursSinceSerpCheck: null }), '2026-09-12'),
    ).toEqual([]);
  });

  it('clears as soon as data flows again', () => {
    const silent = ingest({ hoursSinceGscRow: 100 });
    const alert = evaluateIngest(silent, '2026-09-12')[0]!;

    expect(resolvedIngestSignatures(silent)).not.toContain(alert.signature);
    expect(resolvedIngestSignatures(ingest({ hoursSinceGscRow: 1 }))).toContain(alert.signature);
  });

  it('does not clear a source that has never produced anything', () => {
    // Null is "not started", not "healthy" — resolving on it would close a real
    // alert for a property whose rows were deleted.
    expect(resolvedIngestSignatures(ingest({ hoursSinceGscRow: null }))).not.toContain(
      evaluateIngest(ingest({ hoursSinceGscRow: 100 }), '2026-09-12')[0]!.signature,
    );
  });

  it('records the day, so an older re-run cannot resolve it', () => {
    const [alert] = evaluateIngest(ingest({ hoursSinceGscRow: 100 }), '2026-09-12');
    expect(alert?.payload.day).toBe('2026-09-12');
  });
});
