import { buildProducerDifficultyEvidence } from '@/core/schema/difficulty-evidence';
import { describe, expect, it } from 'vitest';

import {
  EVIDENCE_DEMAND_VERSION,
  EvidenceDemandV1,
  buildSupplyTrace,
  evidenceDemandToTargetContext,
  parseSupplyTrace,
  withSupplyTraceDifficultyEvidence,
} from './evidence-demand';
import { scanCoverageGaps } from './target-discovery';

function demand() {
  return EvidenceDemandV1.parse({
    version: EVIDENCE_DEMAND_VERSION,
    demand_id: 'demand:math:kc-1',
    policy_version: 'supply-v2-phase-a',
    subject_id: 'math',
    claim: {
      kind: 'knowledge_mastery',
      knowledge_ids: ['kc-1'],
      statement: 'learner can apply kc-1',
    },
    evidence: {
      observables: ['correct independent application'],
      minimum_observations: 2,
    },
    task: {
      kinds: ['choice'],
      allowed_uses: ['practice', 'diagnostic'],
    },
    difficulty: {
      band: 'near',
      scale: 'loom_difficulty_v1',
      target_value: 3,
    },
    inventory_goal: {
      eligible_count: 2,
      horizon_days: 7,
    },
    control: {
      needed_by: '2026-07-26T00:00:00.000Z',
      max_budget_micro_usd: 250_000,
      max_attempts: 3,
    },
    causes: [{ kind: 'selection_miss', ref: 'miss-1' }],
  });
}

describe('EvidenceDemand v1', () => {
  it('rejects malformed and incompatible demand versions at the boundary', () => {
    expect(() => EvidenceDemandV1.parse({ ...demand(), version: 2 })).toThrow();
    expect(() =>
      EvidenceDemandV1.parse({
        ...demand(),
        control: { ...demand().control, max_attempts: 0 },
      }),
    ).toThrow();
  });

  it('projects the control envelope and builds a round-trippable supply trace', () => {
    const context = evidenceDemandToTargetContext(demand());
    expect(context).toEqual({
      schema_version: 1,
      demand_id: 'demand:math:kc-1',
      demand_version: 1,
      policy_version: 'supply-v2-phase-a',
      needed_by: '2026-07-26T00:00:00.000Z',
      allowed_uses: ['practice', 'diagnostic'],
      max_budget_micro_usd: 250_000,
      max_attempts: 3,
    });

    const trace = buildSupplyTrace(
      {
        targetId: 'target-1',
        targetFingerprint: 'fp-1',
        context,
      },
      'sourcing_web',
    );
    expect(parseSupplyTrace(trace)).toEqual(trace);
    expect(() => parseSupplyTrace({ ...trace, demand_version: 99 })).toThrow();
  });

  it('correlates multiple targets emitted from the same frontier demand', () => {
    const targets = scanCoverageGaps(
      {
        frontier: [
          {
            knowledgeId: 'kc-1',
            subjectId: 'math',
            thetaHat: 0,
            thetaPrecision: 1,
            evidenceCount: 0,
          },
        ],
        questions: [
          {
            id: 'q-1',
            kind: 'fill_blank',
            source: 'quiz_gen',
            metadata: null,
            difficulty: 3,
            calibrationB: null,
            knowledgeIds: ['kc-1'],
          },
        ],
        routePreferenceBySubject: { math: ['quiz_gen'] },
      },
      (() => {
        let i = 0;
        return () => `target-${++i}`;
      })(),
    );

    expect(targets.length).toBeGreaterThan(1);
    const contexts = targets.map((target) => target.context);
    expect(contexts.every(Boolean)).toBe(true);
    expect(new Set(contexts.map((context) => context?.demand_id))).toEqual(
      new Set(['demand:v1:math:kc-1']),
    );
    expect(contexts.every((context) => context?.demand_version === 1)).toBe(true);
  });

  it('additively preserves production difficulty evidence on a supply trace', () => {
    const trace = buildSupplyTrace(
      {
        targetId: 'target-difficulty',
        targetFingerprint: 'fp-difficulty',
        context: evidenceDemandToTargetContext(demand()),
      },
      'quiz_gen',
    );
    const evidence = buildProducerDifficultyEvidence(4, 'quiz_gen');
    expect(withSupplyTraceDifficultyEvidence(trace, evidence).difficulty_evidence).toEqual(
      evidence,
    );
  });
});
