import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScoringBasisT } from '@/core/schema/assessment';

const evaluateSubmissionSpy = vi.fn();
vi.mock('./evaluate-submission', () => ({
  EvaluateSubmissionError: class extends Error {},
  evaluateSubmission: (...args: unknown[]) => evaluateSubmissionSpy(...args),
}));

import { projectEvaluationToJudgeResult } from './evaluation-authority';

beforeEach(() => {
  evaluateSubmissionSpy.mockReset();
});

describe('projectEvaluationToJudgeResult — pending honesty', () => {
  const baseRecord = {
    evaluation_id: 'eva-1',
    evaluation_group_id: 'grp-1',
    submission_id: 'sub-1',
    attempt: 1,
    run_refs: [],
    plan_digest: 'sha256:x',
    provenance: { source: 'automatic' as const, assisted: false },
  };

  // YUK-1095 — points>0 但没有可归一化分母（no_denominator）时绝不伪造 0 分 /
  // incorrect / confidence=1：没有已发布满分就不能把 points 折成分数，
  // 按 §4.4「不凭空造总分」回落 unsupported（带 reason）。
  it('points>0 but no published denominator ⇒ unsupported (never a fabricated 0/incorrect)', () => {
    const noDenominatorBasis: ScoringBasisT = {
      units: [
        {
          scoring_unit_id: 'p1::u',
          slot_refs: ['p1::r'],
          material_refs: [],
          evidence_slot_refs: [],
          requires_group_evidence: false,
          criterion: { kind: 'text_key', accepted_texts: ['2'], normalization: 'trim' },
          points: 4,
        },
      ],
      // 权重为空 ⇒ totalWeight<=0 ⇒ aggregateMaxPoints=null ⇒ normalized=null。
      aggregation: { kind: 'weighted_sum', weights: {} },
      blank_scores_zero: true,
    };
    const result = projectEvaluationToJudgeResult(
      {
        ...baseRecord,
        status: 'completed',
        unit_results: [
          {
            status: 'scored',
            scoring_unit_id: 'p1::u',
            points_awarded: 3,
            scored_because: 'response',
            evidence_citations: [],
          },
        ],
        aggregate: { kind: 'points_total', points: 3, policy: { kind: 'sum' } },
      },
      noDenominatorBasis,
    );
    expect(result.coarse_outcome).toBe('unsupported');
    expect(result.score).toBeNull();
    expect(result.confidence).toBe(0);
    expect(result.coarse_outcome).not.toBe('incorrect');
    expect(result.score).not.toBe(0);
    expect(result.evidence_json.verdict_reason).toBe('no_denominator');
  });
});
