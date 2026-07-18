import { describe, expect, it } from 'vitest';

import { deriveProfilePresentation } from './ScreenProfile';
import type { PlacementProfile, ProfileKc } from './profile-api';

function kc(id: string, evidenceCount: number, tested = true): ProfileKc {
  return {
    id,
    name: id,
    tested,
    evidence_count: evidenceCount,
    p_l: tested ? 0.5 : undefined,
  };
}

function profile(overrides: Partial<PlacementProfile>): PlacementProfile {
  return {
    goalId: 'goal_1',
    title: '目标',
    kcs: [],
    evidenceCount: 0,
    testedCount: 0,
    totalKcs: 0,
    ...overrides,
  };
}

describe('deriveProfilePresentation (YUK-616)', () => {
  it('把被 evidence cap 截掉的全量 weakest 补进深读面，并保持两段顺序与去重', () => {
    const surfaced = Array.from({ length: 20 }, (_, index) => kc(`kc_${index}`, 10));
    const trueWeakest = kc('kc_weak', 1);

    const result = deriveProfilePresentation(
      profile({
        kcs: surfaced,
        weakest: [trueWeakest, surfaced[3], trueWeakest],
        evidencedCount: 22,
        testedCount: 22,
        totalKcs: 22,
      }),
    );

    expect(result.displayedKcs.map((row) => row.id)).toEqual([
      ...surfaced.map((row) => row.id),
      'kc_weak',
    ]);
    expect(result.weakestExtras.map((row) => row.id)).toEqual(['kc_weak']);
    expect(result.evidencedCount).toBe(22);
  });

  it('旧缓存没有 evidencedCount 时，只按可见的真实作答证据回退，不把零证据软层算覆盖', () => {
    const result = deriveProfilePresentation(
      profile({
        kcs: [kc('evidenced', 2), kc('soft', 0), kc('untested', 0, false)],
        testedCount: 2,
        totalKcs: 3,
      }),
    );

    expect(result.evidencedCount).toBe(1);
  });
});
