import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ScoringBasisT } from '@/core/schema/assessment';

const evaluateSubmissionSpy = vi.fn();
vi.mock('./evaluate-submission', () => ({
  EvaluateSubmissionError: class extends Error {},
  evaluateSubmission: (...args: unknown[]) => evaluateSubmissionSpy(...args),
}));

import {
  EVALUATION_ENTRY_POINTS,
  evaluateAttempt,
  projectEvaluationToJudgeResult,
} from './evaluation-authority';

beforeEach(() => {
  evaluateSubmissionSpy.mockReset();
});

const ENTRY_POINTS = [
  'solo_submit',
  'durable_judge_run',
  'paper_submit',
  'solve_tutor',
  'appeal_rejudge',
  'conjecture_probe',
  'ingestion_grading',
  'advice_preview',
] as const;

const SUM_BASIS: ScoringBasisT = {
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
  aggregation: { kind: 'sum' },
  blank_scores_zero: true,
};

describe('EVALUATION_ENTRY_POINTS registry', () => {
  it('registers exactly the eight §4.2 authoritative grading entries', () => {
    expect(EVALUATION_ENTRY_POINTS.map((e) => e.entry).sort()).toEqual([...ENTRY_POINTS].sort());
    for (const disposition of EVALUATION_ENTRY_POINTS) {
      expect(disposition.lane).toBe('contract');
      expect(disposition.contract_wiring).toBe('wired');
    }
  });
});

describe('evaluateAttempt — lane dispatch', () => {
  it('contract lane delegates to evaluateSubmission and returns the projection', async () => {
    evaluateSubmissionSpy.mockResolvedValue({
      record: {
        evaluation_id: 'eva-1',
        evaluation_group_id: 'grp-1',
        submission_id: 'sub-1',
        attempt: 1,
        status: 'completed',
        unit_results: [
          {
            status: 'scored',
            scoring_unit_id: 'p1::u',
            points_awarded: 4,
            scored_because: 'response',
            evidence_citations: [],
          },
        ],
        aggregate: { kind: 'points_total', points: 4, policy: { kind: 'sum' } },
        plan_digest: 'sha256:abc',
        run_refs: [],
        provenance: { source: 'automatic' as const, assisted: false },
      },
      created_at: new Date(),
      replayed: false,
      scoring_basis: SUM_BASIS,
      model_units_invoked: 0,
      spent_cost_usd_micros: 0,
    });
    const out = await evaluateAttempt({
      entry: 'appeal_rejudge',
      db: {} as never,
      contract: { submission_id: 'sub-1', evaluation_group_id: 'grp-1' },
    });
    expect(out.lane).toBe('contract');
    expect(evaluateSubmissionSpy).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ submission_id: 'sub-1' }),
    );
    expect(out.result.coarse_outcome).toBe('correct');
    expect(out.result.score).toBe(1);
    expect(out.result.capability_ref.id).toBe('evaluate_submission');
  });

  it('contract lane forwards a {kind:"jev"} executor descriptor to evaluateSubmission (YUK-1092)', async () => {
    evaluateSubmissionSpy.mockResolvedValue({
      record: {
        evaluation_id: 'eva-1',
        evaluation_group_id: 'grp-1',
        submission_id: 'sub-1',
        attempt: 1,
        status: 'completed',
        unit_results: [],
        aggregate: { kind: 'points_total', points: 0, policy: { kind: 'sum' } },
        plan_digest: null,
        run_refs: [],
        provenance: { source: 'automatic' as const, assisted: false },
      },
      created_at: new Date(),
      replayed: false,
      scoring_basis: SUM_BASIS,
      model_units_invoked: 1,
      spent_cost_usd_micros: 0,
    });
    const spec = { kind: 'jev' as const, deadline_at: Date.now() + 60_000, rule_threshold: 0.8 };
    const out = await evaluateAttempt({
      entry: 'solo_submit',
      db: {} as never,
      contract: { submission_id: 'sub-1', evaluation_group_id: 'grp-1', model_executor: spec },
    });
    expect(out.lane).toBe('contract');
    // 漏斗不做 descriptor 解析 —— 原样传给 evaluateSubmission 的组合点。
    expect(evaluateSubmissionSpy).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ model_executor: spec }),
    );
  });

  it('rejects inputs carrying both lanes', async () => {
    await expect(
      evaluateAttempt({
        entry: 'paper_submit',
        db: {} as never,
        contract: { submission_id: 's', evaluation_group_id: 'g' },
        legacy: { db: {}, question: {}, answer_md: 'x', subjectProfile: {} } as never,
      } as never),
    ).rejects.toThrow(/legacy grading input is retired/);
  });
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

  it('pending record (retryable infra) ⇒ unsupported, no fabricated score', () => {
    const result = projectEvaluationToJudgeResult(
      {
        ...baseRecord,
        status: 'pending',
        unit_results: [
          {
            status: 'pending',
            scoring_unit_id: 'p1::u',
            pending: { reason: 'infra_failure', retryable: true, detail: 'no port' },
          },
        ],
        aggregate: null,
      },
      SUM_BASIS,
    );
    expect(result.coarse_outcome).toBe('unsupported');
    expect(result.score).toBeNull();
    expect(result.confidence).toBe(0);
    expect(result.evidence_json.pending_units).toHaveLength(1);
  });

  it('unresolved aggregate ⇒ unsupported with the honest reason', () => {
    const result = projectEvaluationToJudgeResult(
      {
        ...baseRecord,
        status: 'completed',
        unit_results: [
          {
            status: 'pending',
            scoring_unit_id: 'p1::u',
            pending: { reason: 'needs_review', trigger: 'flagged', detail: 'blank' },
          },
        ],
        aggregate: { kind: 'unresolved', reason: 'pending_units', detail: 'p1::u' },
      },
      SUM_BASIS,
    );
    expect(result.coarse_outcome).toBe('unsupported');
    expect(result.score).toBeNull();
    expect(result.evidence_json.aggregate_reason).toBe('pending_units');
  });

  it('full marks ⇒ correct (score normalized against published max)', () => {
    const result = projectEvaluationToJudgeResult(
      {
        ...baseRecord,
        status: 'completed',
        unit_results: [
          {
            status: 'scored',
            scoring_unit_id: 'p1::u',
            points_awarded: 4,
            scored_because: 'response',
            evidence_citations: [],
          },
        ],
        aggregate: { kind: 'points_total', points: 4, policy: { kind: 'sum' } },
      },
      SUM_BASIS,
    );
    expect(result.coarse_outcome).toBe('correct');
    expect(result.score).toBe(1);
  });

  it('zero marks ⇒ incorrect with score 0', () => {
    const result = projectEvaluationToJudgeResult(
      {
        ...baseRecord,
        status: 'completed',
        unit_results: [
          {
            status: 'scored',
            scoring_unit_id: 'p1::u',
            points_awarded: 0,
            scored_because: 'blank_marked_zero',
            evidence_citations: [],
          },
        ],
        aggregate: { kind: 'points_total', points: 0, policy: { kind: 'sum' } },
      },
      SUM_BASIS,
    );
    expect(result.coarse_outcome).toBe('incorrect');
    expect(result.score).toBe(0);
  });

  it('partial points across units ⇒ partial with normalized score', () => {
    const basis: ScoringBasisT = {
      units: [
        {
          scoring_unit_id: 'a::u',
          slot_refs: [],
          material_refs: [],
          evidence_slot_refs: [],
          requires_group_evidence: false,
          criterion: { kind: 'text_key', accepted_texts: ['x'], normalization: 'trim' },
          points: 2,
        },
        {
          scoring_unit_id: 'b::u',
          slot_refs: [],
          material_refs: [],
          evidence_slot_refs: [],
          requires_group_evidence: false,
          criterion: { kind: 'text_key', accepted_texts: ['y'], normalization: 'trim' },
          points: 2,
        },
      ],
      aggregation: { kind: 'sum' },
      blank_scores_zero: true,
    };
    const result = projectEvaluationToJudgeResult(
      {
        ...baseRecord,
        status: 'completed',
        unit_results: [
          {
            status: 'scored',
            scoring_unit_id: 'a::u',
            points_awarded: 2,
            scored_because: 'response',
            evidence_citations: [],
          },
          {
            status: 'scored',
            scoring_unit_id: 'b::u',
            points_awarded: 0,
            scored_because: 'response',
            evidence_citations: [],
          },
        ],
        aggregate: { kind: 'points_total', points: 2, policy: { kind: 'sum' } },
      },
      basis,
    );
    expect(result.coarse_outcome).toBe('partial');
    expect(result.score).toBeCloseTo(0.5);
  });

  it('unmapped holistic level ⇒ unsupported (no fabricated total)', () => {
    const result = projectEvaluationToJudgeResult(
      {
        ...baseRecord,
        status: 'completed',
        unit_results: [],
        aggregate: { kind: 'level', level_id: 'excellent', points: null },
      },
      SUM_BASIS,
    );
    expect(result.coarse_outcome).toBe('unsupported');
    expect(result.score).toBeNull();
  });

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
