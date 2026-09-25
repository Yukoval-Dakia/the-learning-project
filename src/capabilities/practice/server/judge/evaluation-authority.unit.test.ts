// YUK-1047 — evaluateAttempt 漏斗 + contract→JudgeResultV2 投影单测（无 DB、无 LLM）。
//
// 断言：
//   1. EVALUATION_ENTRY_POINTS 恰好登记 grounding §4.2 的八个权威入口；
//   2. lane 互斥：同传 contract+legacy fail-loud；
//   3. legacy lane 透传 JudgeInvokerOutput 并打 lane/entry 标签；
//   4. contract lane 经 evaluateSubmission 落库 + JudgeResultV2 投影；
//   5. 投影纪律：pending/unresolved/未映射档位绝不造伪分（全部 unsupported），
//      points_total 只在有分母时归一化。

import { describe, expect, it, vi, beforeEach } from 'vitest';

import type { ScoringBasisT } from '@/core/schema/assessment';

// 隔离 invoker / evaluate-submission：漏斗的 lane 分派与投影是纯协调逻辑，
// 真实的判分/落库分别由各自测试覆盖（invoker.test.ts /
// evaluate-submission.db.test.ts）。
const invokeSpy = vi.fn();
vi.mock('./invoker', () => ({
  createDefaultJudgeInvoker: () => ({ invoke: invokeSpy }),
}));
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
  invokeSpy.mockReset();
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
    expect(EVALUATION_ENTRY_POINTS.map((e) => e.entry).sort()).toEqual(
      [...ENTRY_POINTS].sort(),
    );
    // Every entry honestly records its current lane + blocking tickets — no
    // entry claims 'wired' while contract writers (YUK-1052) have not landed.
    for (const disposition of EVALUATION_ENTRY_POINTS) {
      expect(disposition.lane).toBe('legacy');
      expect(disposition.contract_wiring).toBe('pending_writer');
      expect(disposition.blocked_by).toContain('YUK-1052');
    }
  });
});

describe('evaluateAttempt — lane dispatch', () => {
  it('legacy lane passes through the invoker output verbatim + tags lane/entry', async () => {
    const invoked = {
      route: 'exact',
      result: {
        score: 0,
        score_meaning: 'correctness',
        coarse_outcome: 'incorrect',
        confidence: 1,
        capability_ref: { id: 'exact', version: '1.0.0' },
        feedback_md: 'no match',
        evidence_json: {},
      },
      telemetry: {
        route: 'exact',
        capability_ref: { id: 'exact', version: '1.0.0' },
        coarse_outcome: 'incorrect',
        confidence: 1,
        elapsed_ms: 1,
        question_id: 'q1',
        subject_id: 'math',
        profile_version: '1',
      },
      modelAttempted: false,
    };
    invokeSpy.mockResolvedValue(invoked);
    const params = {
      db: {},
      question: { id: 'q1', kind: 'single_choice' },
      answer_md: 'A',
      subjectProfile: {},
    } as never;
    const out = await evaluateAttempt({ entry: 'solo_submit', legacy: params });
    expect(out.lane).toBe('legacy');
    expect(out.entry).toBe('solo_submit');
    expect(out.result).toEqual(invoked.result);
    expect(out.telemetry).toEqual(invoked.telemetry);
    expect(invokeSpy).toHaveBeenCalledWith(params);
    expect(evaluateSubmissionSpy).not.toHaveBeenCalled();
  });

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
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it('rejects inputs carrying both lanes', async () => {
    await expect(
      evaluateAttempt({
        entry: 'paper_submit',
        db: {} as never,
        contract: { submission_id: 's', evaluation_group_id: 'g' },
        legacy: { db: {}, question: {}, answer_md: 'x', subjectProfile: {} } as never,
      } as never),
    ).rejects.toThrow(/both contract and legacy/);
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
});
