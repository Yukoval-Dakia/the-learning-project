// YUK-455 inc-E — PURE prereqRiskFromAttempt 单测（无 IO / 无 DB）。住 core/ →
// vitest.shared fastTestInclude 的 `src/core/**/*.test.ts` glob 自动落 unit 分区。

import { describe, expect, it } from 'vitest';
import {
  PREREQ_RISK_BASE_WEIGHT,
  PREREQ_RISK_DEPTH_DECAY,
  type PrereqClosureEdge,
  prereqRiskFromAttempt,
} from './prereq-risk';

describe('prereqRiskFromAttempt (YUK-455 inc-E, PURE)', () => {
  it('empty closure → empty map (NO-OP)', () => {
    expect(prereqRiskFromAttempt([]).size).toBe(0);
  });

  it('single direct prereq (depth 1) → risk = baseWeight, min_depth 1', () => {
    const closure: PrereqClosureEdge[] = [{ prereq_kc: 'A', source_kc: 'B', depth: 1 }];
    const out = prereqRiskFromAttempt(closure);
    expect(out.size).toBe(1);
    const a = out.get('A');
    expect(a).toBeDefined();
    expect(a?.risk_delta).toBeCloseTo(PREREQ_RISK_BASE_WEIGHT, 10);
    expect(a?.min_depth).toBe(1);
    expect(a?.contributions).toEqual([{ source_kc: 'B', depth: 1, risk: PREREQ_RISK_BASE_WEIGHT }]);
  });

  it('geometric depth decay: depth-d prereq gets base · decay^(d-1)', () => {
    const closure: PrereqClosureEdge[] = [
      { prereq_kc: 'A1', source_kc: 'B', depth: 1 },
      { prereq_kc: 'A2', source_kc: 'B', depth: 2 },
      { prereq_kc: 'A3', source_kc: 'B', depth: 3 },
    ];
    const out = prereqRiskFromAttempt(closure);
    expect(out.get('A1')?.risk_delta).toBeCloseTo(PREREQ_RISK_BASE_WEIGHT, 10);
    expect(out.get('A2')?.risk_delta).toBeCloseTo(
      PREREQ_RISK_BASE_WEIGHT * PREREQ_RISK_DEPTH_DECAY,
      10,
    );
    expect(out.get('A3')?.risk_delta).toBeCloseTo(
      PREREQ_RISK_BASE_WEIGHT * PREREQ_RISK_DEPTH_DECAY ** 2,
      10,
    );
  });

  it('overridable baseWeight + depthDecay (owner-fixed priors are params)', () => {
    const closure: PrereqClosureEdge[] = [{ prereq_kc: 'A', source_kc: 'B', depth: 2 }];
    const out = prereqRiskFromAttempt(closure, { baseWeight: 4, depthDecay: 0.25 });
    expect(out.get('A')?.risk_delta).toBeCloseTo(4 * 0.25, 10); // 4 · 0.25^(2-1) = 1
  });

  it('same prereq reached at multiple depths → MAX implication (min_depth), keeps all contributions', () => {
    const closure: PrereqClosureEdge[] = [
      { prereq_kc: 'A', source_kc: 'B', depth: 3 },
      { prereq_kc: 'A', source_kc: 'C', depth: 1 }, // closest → wins risk_delta
    ];
    const out = prereqRiskFromAttempt(closure);
    const a = out.get('A');
    expect(a?.risk_delta).toBeCloseTo(PREREQ_RISK_BASE_WEIGHT, 10); // depth 1 = strongest
    expect(a?.min_depth).toBe(1);
    expect(a?.contributions).toHaveLength(2);
  });

  it('multiple source KCs → contributions deterministically sorted (source_kc, then depth)', () => {
    const closure: PrereqClosureEdge[] = [
      { prereq_kc: 'A', source_kc: 'Z', depth: 1 },
      { prereq_kc: 'A', source_kc: 'M', depth: 2 },
      { prereq_kc: 'A', source_kc: 'M', depth: 1 },
    ];
    const out = prereqRiskFromAttempt(closure);
    expect(out.get('A')?.contributions.map((c) => [c.source_kc, c.depth])).toEqual([
      ['M', 1],
      ['M', 2],
      ['Z', 1],
    ]);
  });

  it('self-implication edge (prereq_kc === source_kc) is dropped', () => {
    const closure: PrereqClosureEdge[] = [
      { prereq_kc: 'B', source_kc: 'B', depth: 1 },
      { prereq_kc: 'A', source_kc: 'B', depth: 1 },
    ];
    const out = prereqRiskFromAttempt(closure);
    expect(out.has('B')).toBe(false);
    expect(out.has('A')).toBe(true);
  });

  it('is deterministic: same input → identical output across runs', () => {
    const closure: PrereqClosureEdge[] = [
      { prereq_kc: 'A', source_kc: 'B', depth: 1 },
      { prereq_kc: 'A', source_kc: 'C', depth: 2 },
      { prereq_kc: 'D', source_kc: 'B', depth: 2 },
    ];
    const a = prereqRiskFromAttempt(closure);
    const b = prereqRiskFromAttempt(closure);
    expect(JSON.stringify([...a.entries()])).toEqual(JSON.stringify([...b.entries()]));
  });
});
