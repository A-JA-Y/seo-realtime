import { describe, expect, it } from 'vitest';

import { rankingUrlChanges } from './queries';
import type { RankPoint } from './queries';

function check(hour: number, rankingUrl: string | null, found = rankingUrl !== null): RankPoint {
  return {
    checkedAt: new Date(Date.UTC(2026, 8, 1, hour)),
    rankGroup: found ? 5 : null,
    rankAbsolute: found ? 8 : null,
    found,
    serpFeatures: null,
    rankingUrl,
  };
}

describe('rankingUrlChanges', () => {
  it('reports nothing when the same URL ranks throughout', () => {
    expect(rankingUrlChanges([check(1, '/a'), check(2, '/a'), check(3, '/a')])).toEqual([]);
  });

  it('reports a swap, with both ends', () => {
    const changes = rankingUrlChanges([check(1, '/a'), check(2, '/b')]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ from: '/a', to: '/b' });
  });

  it('puts the most recent change first', () => {
    const changes = rankingUrlChanges([check(1, '/a'), check(2, '/b'), check(3, '/c')]);
    expect(changes.map((c) => c.to)).toEqual(['/c', '/b']);
  });

  /*
   * The behaviour this function exists for. A keyword that drops out of the top
   * 100 and comes back on the same page produced TWO phantom "URL changes"
   * (url → none, none → url), which buried the real signal — Google quietly
   * preferring a different page of yours — under noise from a different event
   * with a different cause.
   */
  it('does not report dropping out and returning on the same page as a change', () => {
    const history = [
      check(1, '/a'),
      check(2, null),
      check(3, null),
      check(4, '/a'),
    ];
    expect(rankingUrlChanges(history)).toEqual([]);
  });

  it('still reports a swap that happened across a not-found stretch', () => {
    const changes = rankingUrlChanges([check(1, '/a'), check(2, null), check(3, '/b')]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ from: '/a', to: '/b' });
  });

  it('ignores a found check that somehow carries no URL', () => {
    // Defensive: `found` and a null ranking_url should not co-occur, but a
    // reported change from a URL to nothing would be a lie if it did.
    const changes = rankingUrlChanges([check(1, '/a'), check(2, null, true), check(3, '/a')]);
    expect(changes).toEqual([]);
  });

  it('reports nothing for a history of one check', () => {
    expect(rankingUrlChanges([check(1, '/a')])).toEqual([]);
    expect(rankingUrlChanges([])).toEqual([]);
  });
});
