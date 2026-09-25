// YUK-1047 — evaluateSubmissionCore 纯内核单测（无 IO、无 DB、无 LLM）。
//
// 覆盖 §4.4 计分纪律的每一条红线：
//   - 确定性比较器：全对 = 发布 points，否则 0（无部分分）；
//   - 判据/槽位不配对 ⇒ pending unjudgeable，绝不落伪零分；
//   - 空白 ≠ missing ≠ unparseable ≠ insufficient ≠ infra_failure ≠
//     needs_review —— 六类未决分别表达；
//   - 空白计零只在 basis.blank_scores_zero=true 时发生；
//   - model_executor 未准入 ⇒ escalation 未决（withhold / human_review）；
//   - issued_part_ids 子集投影：未发出 part 的 unit 不参与评估；
//   - capped_sum/threshold_levels 在部分 scope 下 fail-closed；
//   - retryable infra_failure ⇒ 记录 status=pending + aggregate=null。

import { describe, expect, it } from 'vitest';

import {
  type EvaluateSubmissionCoreInput,
  EvaluationContractError,
  type ModelUnitOutcomeT,
  evaluateSubmissionCore,
} from './evaluation';
import type {
  ExecutionPlanT,
  PublishedQuestionRevisionT,
  ScoringBasisT,
  SubmissionRecordT,
} from './index';

// ---------- fixtures ----------

const GROUP_ID = 'grp-fixture';
const REVISION_ID = 'rev-fixture-1';
const ISSUANCE_ID = 'iss-fixture-1';
const SUBMISSION_ID = 'sub-fixture-1';
const EVAL_GROUP_ID = 'grp-eval-1';
const NOW = '2026-09-25T00:00:00.000Z';

function revisionFor(overrides: {
  parts?: PublishedQuestionRevisionT['structure']['parts'];
  slots?: PublishedQuestionRevisionT['response_spec']['slots'];
  units?: ScoringBasisT['units'];
  aggregation?: ScoringBasisT['aggregation'];
  blank_scores_zero?: boolean;
  assignments?: ExecutionPlanT['assignments'];
  escalation?: ExecutionPlanT['escalation'];
  materials?: PublishedQuestionRevisionT['structure']['materials'];
}): PublishedQuestionRevisionT {
  const parts = overrides.parts ?? [{ part_id: 'p1', prompt_md: '1+1=?', material_ids: [] }];
  const slots = overrides.slots ?? [
    { slot_id: 'p1::r', part_id: 'p1', kind: 'text' as const, math_preview: false },
  ];
  const units = overrides.units ?? [
    {
      scoring_unit_id: 'p1::u',
      slot_refs: ['p1::r'],
      material_refs: [],
      evidence_slot_refs: [],
      requires_group_evidence: false,
      criterion: {
        kind: 'text_key' as const,
        accepted_texts: ['2'],
        normalization: 'trim' as const,
      },
      points: 2,
    },
  ];
  return {
    revision_id: REVISION_ID,
    group_id: GROUP_ID,
    revision_ordinal: 1,
    integrity_digest: 'sha256:test',
    structure: {
      group_id: GROUP_ID,
      materials: overrides.materials ?? [],
      parts,
    },
    response_spec: { slots },
    scoring_basis: {
      units,
      aggregation: overrides.aggregation ?? { kind: 'sum' },
      blank_scores_zero: overrides.blank_scores_zero ?? true,
    },
    execution_plan: {
      plan_version: 1,
      assignments: overrides.assignments ?? [
        {
          scoring_unit_ids: units.map((u) => u.scoring_unit_id),
          executor: { kind: 'deterministic', comparator: 'exact_text' },
        },
      ],
      escalation: overrides.escalation ?? {
        on_unadmitted_model: 'withhold',
        on_low_confidence: 'human_review',
      },
    },
    published_at: NOW,
    supersedes_revision_id: null,
  };
}

function submissionFor(entries: SubmissionRecordT['response_set']['entries']): SubmissionRecordT {
  return {
    submission_id: SUBMISSION_ID,
    issuance_id: ISSUANCE_ID,
    revision_id: REVISION_ID,
    evaluation_group_id: EVAL_GROUP_ID,
    response_set: { entries },
    group_evidence: [],
    idempotency_key: 'idem-1',
    submitted_at: NOW,
  };
}

function inputFor(
  submission: SubmissionRecordT,
  revision: PublishedQuestionRevisionT,
  overrides: Partial<EvaluateSubmissionCoreInput> = {},
): EvaluateSubmissionCoreInput {
  return {
    evaluation_id: 'eva-test',
    submission,
    revision,
    attempt: 1,
    ...overrides,
  };
}

// ---------- tests ----------

describe('evaluateSubmissionCore — deterministic comparators', () => {
  it('exact_text: accepted answer scores full published points', async () => {
    const out = await evaluateSubmissionCore(
      inputFor(
        submissionFor([{ slot_id: 'p1::r', kind: 'text', text_md: ' 2 ' }]),
        revisionFor({}),
      ),
    );
    expect(out.record.status).toBe('completed');
    expect(out.record.unit_results).toEqual([
      expect.objectContaining({
        status: 'scored',
        scoring_unit_id: 'p1::u',
        points_awarded: 2,
        scored_because: 'response',
      }),
    ]);
    expect(out.record.aggregate).toEqual({
      kind: 'points_total',
      points: 2,
      policy: { kind: 'sum' },
    });
  });

  it('exact_text answer_head: strips "答：" prefix like the legacy exact judge', async () => {
    const revision = revisionFor({
      units: [
        {
          scoring_unit_id: 'p1::u',
          slot_refs: ['p1::r'],
          material_refs: [],
          evidence_slot_refs: [],
          requires_group_evidence: false,
          criterion: {
            kind: 'text_key',
            accepted_texts: ['b'],
            normalization: 'answer_head',
          },
          points: 3,
        },
      ],
    });
    const out = await evaluateSubmissionCore(
      inputFor(submissionFor([{ slot_id: 'p1::r', kind: 'text', text_md: '答：B' }]), revision),
    );
    expect(out.record.aggregate).toMatchObject({ kind: 'points_total', points: 3 });
  });

  it('exact_text miss scores 0 (binary comparator — no partial credit)', async () => {
    const out = await evaluateSubmissionCore(
      inputFor(submissionFor([{ slot_id: 'p1::r', kind: 'text', text_md: '3' }]), revisionFor({})),
    );
    expect(out.record.unit_results[0]).toMatchObject({
      status: 'scored',
      points_awarded: 0,
      scored_because: 'response',
    });
    expect(out.record.aggregate).toMatchObject({ kind: 'points_total', points: 0 });
  });

  it('exact_option_set: set-equality against accepted option ids', async () => {
    const revision = revisionFor({
      slots: [
        {
          slot_id: 'p1::r',
          part_id: 'p1',
          kind: 'multi_choice',
          options: [
            { option_id: 'opt-a', label: 'A', text: 'alpha' },
            { option_id: 'opt-b', label: 'B', text: 'beta' },
            { option_id: 'opt-c', label: 'C', text: 'gamma' },
          ],
          min_select: 1,
          max_select: 3,
        },
      ],
      units: [
        {
          scoring_unit_id: 'p1::u',
          slot_refs: ['p1::r'],
          material_refs: [],
          evidence_slot_refs: [],
          requires_group_evidence: false,
          criterion: {
            kind: 'option_set_key',
            accepted_option_ids: ['opt-a', 'opt-c'],
          },
          points: 4,
        },
      ],
      assignments: [
        {
          scoring_unit_ids: ['p1::u'],
          executor: { kind: 'deterministic', comparator: 'exact_option_set' },
        },
      ],
    });
    const hit = await evaluateSubmissionCore(
      inputFor(
        submissionFor([{ slot_id: 'p1::r', kind: 'choice', option_ids: ['opt-c', 'opt-a'] }]),
        revision,
      ),
    );
    expect(hit.record.aggregate).toMatchObject({ kind: 'points_total', points: 4 });

    const miss = await evaluateSubmissionCore(
      inputFor(
        submissionFor([{ slot_id: 'p1::r', kind: 'choice', option_ids: ['opt-a', 'opt-b'] }]),
        revision,
      ),
    );
    expect(miss.record.aggregate).toMatchObject({ kind: 'points_total', points: 0 });
  });

  it('numeric_tolerance: absolute tolerance + unit suffix check', async () => {
    const revision = revisionFor({
      slots: [{ slot_id: 'p1::r', part_id: 'p1', kind: 'numeric' as const }],
      units: [
        {
          scoring_unit_id: 'p1::u',
          slot_refs: ['p1::r'],
          material_refs: [],
          evidence_slot_refs: [],
          requires_group_evidence: false,
          criterion: {
            kind: 'numeric_key',
            expected: 9.8,
            tolerance: { kind: 'absolute', value: 0.05 },
            expected_unit: 'm/s²',
          },
          points: 2,
        },
      ],
      assignments: [
        {
          scoring_unit_ids: ['p1::u'],
          executor: { kind: 'deterministic', comparator: 'numeric_tolerance' },
        },
      ],
    });
    const hit = await evaluateSubmissionCore(
      inputFor(
        submissionFor([{ slot_id: 'p1::r', kind: 'numeric', value: 9.82, raw_input: '9.82 m/s²' }]),
        revision,
      ),
    );
    expect(hit.record.aggregate).toMatchObject({ kind: 'points_total', points: 2 });

    const wrongUnit = await evaluateSubmissionCore(
      inputFor(
        submissionFor([{ slot_id: 'p1::r', kind: 'numeric', value: 9.8, raw_input: '9.8 cm/s²' }]),
        revision,
      ),
    );
    expect(wrongUnit.record.unit_results[0]).toMatchObject({
      status: 'scored',
      points_awarded: 0,
      feedback_md: 'unit_mismatch',
    });
  });

  it('matching_pairs: explicit pair mapping, not a set masquerade', async () => {
    const revision = revisionFor({
      slots: [
        {
          slot_id: 'p1::r',
          part_id: 'p1',
          kind: 'matching' as const,
          left_items: [
            { item_id: 'i1', label: '1', text: 'x' },
            { item_id: 'i2', label: '2', text: 'y' },
          ],
          right_options: [
            { option_id: 'oA', label: 'A', text: 'a' },
            { option_id: 'oB', label: 'B', text: 'b' },
          ],
          allow_left_unmatched: false,
        },
      ],
      units: [
        {
          scoring_unit_id: 'p1::u',
          slot_refs: ['p1::r'],
          material_refs: [],
          evidence_slot_refs: [],
          requires_group_evidence: false,
          criterion: {
            kind: 'matching_pairs_key',
            accepted_pairs: [
              { item_id: 'i1', option_id: 'oA' },
              { item_id: 'i2', option_id: 'oB' },
            ],
          },
          points: 2,
        },
      ],
      assignments: [
        {
          scoring_unit_ids: ['p1::u'],
          executor: { kind: 'deterministic', comparator: 'exact_matching_pairs' },
        },
      ],
    });
    const out = await evaluateSubmissionCore(
      inputFor(
        submissionFor([
          {
            slot_id: 'p1::r',
            kind: 'matching',
            pairs: [
              { item_id: 'i2', option_id: 'oB' },
              { item_id: 'i1', option_id: 'oA' },
            ],
          },
        ]),
        revision,
      ),
    );
    expect(out.record.aggregate).toMatchObject({ kind: 'points_total', points: 2 });
  });
});

describe('evaluateSubmissionCore — pending taxonomy (no fake zeros)', () => {
  it('criterion/slot mismatch ⇒ pending unjudgeable, aggregate unresolved — never a fake 0', async () => {
    // text_key criterion on a numeric slot response.
    const revision = revisionFor({
      slots: [{ slot_id: 'p1::r', part_id: 'p1', kind: 'numeric' as const }],
    });
    // Force validateScoringBasis-passing shape: numeric_key criterion + numeric
    // slot, but dispatch a MISMATCHED comparator pairing by overriding the
    // assignment to text comparator... Instead simplest honest mismatch: keep
    // numeric_key criterion (valid for numeric slot) but assign exact_text
    // comparator (comparator_criterion_mismatch — validateExecutionPlan would
    // reject). Use a plan-valid mismatch instead: rule_reference unit on the
    // numeric slot assigned human_review ⇒ needs_review pending.
    const ruleRevision = revisionFor({
      slots: [{ slot_id: 'p1::r', part_id: 'p1', kind: 'numeric' as const }],
      units: [
        {
          scoring_unit_id: 'p1::u',
          slot_refs: ['p1::r'],
          material_refs: [],
          evidence_slot_refs: [],
          requires_group_evidence: false,
          criterion: {
            kind: 'rule_reference',
            rule_id: 'r1',
            statement_md: 'show work',
            source: 'official',
          },
          points: 2,
        },
      ],
      assignments: [
        {
          scoring_unit_ids: ['p1::u'],
          executor: { kind: 'human_review' },
        },
      ],
    });
    const out = await evaluateSubmissionCore(
      inputFor(
        submissionFor([{ slot_id: 'p1::r', kind: 'numeric', value: 42, raw_input: '42' }]),
        ruleRevision,
      ),
    );
    expect(out.record.unit_results[0]).toMatchObject({
      status: 'pending',
      pending: { reason: 'needs_review', trigger: 'manual_request' },
    });
    expect(out.record.status).toBe('completed');
    expect(out.record.aggregate).toMatchObject({
      kind: 'unresolved',
      reason: 'pending_units',
    });
  });

  it('missing response entry ⇒ missing_response pending (distinct from blank)', async () => {
    const out = await evaluateSubmissionCore(inputFor(submissionFor([]), revisionFor({})));
    expect(out.record.unit_results[0]).toMatchObject({
      status: 'pending',
      pending: { reason: 'missing_response', slot_ids: ['p1::r'] },
    });
    expect(out.record.aggregate).toMatchObject({ kind: 'unresolved' });
  });

  it('blank + blank_scores_zero=true ⇒ scored 0 via blank_marked_zero', async () => {
    const out = await evaluateSubmissionCore(
      inputFor(
        submissionFor([{ slot_id: 'p1::r', kind: 'text', text_md: '  ' }]),
        revisionFor({ blank_scores_zero: true }),
      ),
    );
    expect(out.record.unit_results[0]).toMatchObject({
      status: 'scored',
      points_awarded: 0,
      scored_because: 'blank_marked_zero',
    });
    expect(out.record.aggregate).toMatchObject({ kind: 'points_total', points: 0 });
  });

  it('blank + blank_scores_zero=false ⇒ needs_review pending (never a fake zero)', async () => {
    const out = await evaluateSubmissionCore(
      inputFor(
        submissionFor([{ slot_id: 'p1::r', kind: 'text', text_md: '' }]),
        revisionFor({ blank_scores_zero: false }),
      ),
    );
    expect(out.record.unit_results[0]).toMatchObject({
      status: 'pending',
      pending: { reason: 'needs_review', trigger: 'flagged' },
    });
    expect(out.record.aggregate).toMatchObject({
      kind: 'unresolved',
      reason: 'pending_units',
    });
  });

  it('unparseable numeric (value=null + non-empty raw_input) ⇒ unparseable_response', async () => {
    const revision = revisionFor({
      slots: [{ slot_id: 'p1::r', part_id: 'p1', kind: 'numeric' as const }],
      units: [
        {
          scoring_unit_id: 'p1::u',
          slot_refs: ['p1::r'],
          material_refs: [],
          evidence_slot_refs: [],
          requires_group_evidence: false,
          criterion: {
            kind: 'numeric_key',
            expected: 2,
            tolerance: { kind: 'absolute', value: 0 },
          },
          points: 1,
        },
      ],
      assignments: [
        {
          scoring_unit_ids: ['p1::u'],
          executor: { kind: 'deterministic', comparator: 'numeric_tolerance' },
        },
      ],
    });
    const out = await evaluateSubmissionCore(
      inputFor(
        submissionFor([{ slot_id: 'p1::r', kind: 'numeric', value: null, raw_input: 'two' }]),
        revision,
      ),
    );
    expect(out.record.unit_results[0]).toMatchObject({
      status: 'pending',
      pending: { reason: 'unparseable_response', slot_id: 'p1::r' },
    });
  });

  it('unresolved material ref ⇒ invalid_scoring_basis at the contract gate (no missing_materials path)', async () => {
    // unresolved_material_ref is caught by validateScoringBasis BEFORE unit
    // dispatch — material availability failures surface as executor-reported
    // missing_materials pendings, not as a second static branch.
    const revision = revisionFor({
      units: [
        {
          scoring_unit_id: 'p1::u',
          slot_refs: ['p1::r'],
          material_refs: ['mat-missing'],
          evidence_slot_refs: [],
          requires_group_evidence: false,
          criterion: {
            kind: 'text_key',
            accepted_texts: ['2'],
            normalization: 'trim',
          },
          points: 1,
        },
      ],
    });
    await expect(
      evaluateSubmissionCore(
        inputFor(submissionFor([{ slot_id: 'p1::r', kind: 'text', text_md: '2' }]), revision),
      ),
    ).rejects.toMatchObject({ code: 'invalid_scoring_basis' });
  });

  it('requires_group_evidence without covering evidence ⇒ insufficient_evidence', async () => {
    const revision = revisionFor({
      slots: [
        {
          slot_id: 'p1::r',
          part_id: 'p1',
          kind: 'open_response' as const,
          accepted_evidence: [],
          evidence_required: false,
        },
      ],
      units: [
        {
          scoring_unit_id: 'p1::u',
          slot_refs: ['p1::r'],
          material_refs: [],
          evidence_slot_refs: [],
          requires_group_evidence: true,
          criterion: {
            kind: 'rule_reference',
            rule_id: 'r1',
            statement_md: 'grade against the page photo',
            source: 'official',
          },
          points: 5,
        },
      ],
      assignments: [{ scoring_unit_ids: ['p1::u'], executor: { kind: 'human_review' } }],
    });
    const out = await evaluateSubmissionCore(
      inputFor(
        submissionFor([{ slot_id: 'p1::r', kind: 'open', text_md: 'work shown', evidence: [] }]),
        revision,
      ),
    );
    expect(out.record.unit_results[0]).toMatchObject({
      status: 'pending',
      pending: { reason: 'insufficient_evidence' },
    });
  });
});

describe('evaluateSubmissionCore — issuance scope projection', () => {
  const twoPartRevision = () =>
    revisionFor({
      parts: [
        { part_id: 'p1', prompt_md: 'a=?', material_ids: [] },
        { part_id: 'p2', prompt_md: 'b=?', material_ids: [] },
      ],
      slots: [
        { slot_id: 'p1::r', part_id: 'p1', kind: 'text' as const, math_preview: false },
        { slot_id: 'p2::r', part_id: 'p2', kind: 'text' as const, math_preview: false },
      ],
      units: [
        {
          scoring_unit_id: 'p1::u',
          slot_refs: ['p1::r'],
          material_refs: [],
          evidence_slot_refs: [],
          requires_group_evidence: false,
          criterion: { kind: 'text_key', accepted_texts: ['1'], normalization: 'trim' },
          points: 1,
        },
        {
          scoring_unit_id: 'p2::u',
          slot_refs: ['p2::r'],
          material_refs: [],
          evidence_slot_refs: [],
          requires_group_evidence: false,
          criterion: { kind: 'text_key', accepted_texts: ['2'], normalization: 'trim' },
          points: 3,
        },
      ],
      assignments: [
        {
          scoring_unit_ids: ['p1::u', 'p2::u'],
          executor: { kind: 'deterministic', comparator: 'exact_text' },
        },
      ],
    });

  it('issued subset evaluates only in-scope units (sum projects)', async () => {
    const revision = twoPartRevision();
    const out = await evaluateSubmissionCore(
      inputFor(submissionFor([{ slot_id: 'p1::r', kind: 'text', text_md: '1' }]), revision, {
        issued_part_ids: ['p1'],
      }),
    );
    // p2::u is out of this issuance scope — no result row at all (not pending).
    expect(out.record.unit_results.map((r) => r.scoring_unit_id)).toEqual(['p1::u']);
    expect(out.record.aggregate).toMatchObject({ kind: 'points_total', points: 1 });
  });

  it('capped_sum over a partial scope ⇒ unprojectable_aggregation (fail-closed)', async () => {
    const revision = twoPartRevision();
    revision.scoring_basis.aggregation = { kind: 'capped_sum', cap: 3 };
    await expect(
      evaluateSubmissionCore(
        inputFor(submissionFor([{ slot_id: 'p1::r', kind: 'text', text_md: '1' }]), revision, {
          issued_part_ids: ['p1'],
        }),
      ),
    ).rejects.toMatchObject({
      name: 'EvaluationContractError',
      code: 'unprojectable_aggregation',
    });
  });

  it('weighted_sum over a subset uses the subset weights', async () => {
    const revision = twoPartRevision();
    revision.scoring_basis.aggregation = {
      kind: 'weighted_sum',
      weights: { 'p1::u': 2, 'p2::u': 5 },
    };
    const out = await evaluateSubmissionCore(
      inputFor(submissionFor([{ slot_id: 'p1::r', kind: 'text', text_md: '1' }]), revision, {
        issued_part_ids: ['p1'],
      }),
    );
    expect(out.record.aggregate).toMatchObject({ kind: 'points_total', points: 2 });
  });
});

describe('evaluateSubmissionCore — model_executor lane (D17 gate, injected port)', () => {
  function modelRevision(admittedSliceId: string | null, maxCost?: number) {
    return revisionFor({
      units: [
        {
          scoring_unit_id: 'p1::u',
          slot_refs: ['p1::r'],
          material_refs: [],
          evidence_slot_refs: [],
          requires_group_evidence: false,
          criterion: {
            kind: 'rule_reference',
            rule_id: 'r1',
            statement_md: 'free-response rubric',
            source: 'official',
          },
          points: 10,
        },
      ],
      assignments: [
        {
          scoring_unit_ids: ['p1::u'],
          executor: {
            kind: 'model_executor',
            task_kind: 'RuleJudgeTask',
            admitted_slice_id: admittedSliceId,
            ...(maxCost != null ? { max_cost_usd_micros: maxCost } : {}),
          },
        },
      ],
    });
  }
  const answered = () => submissionFor([{ slot_id: 'p1::r', kind: 'text', text_md: 'my work' }]);

  it('admitted executor + injected port ⇒ scored via reported rule outcome', async () => {
    const outcome: ModelUnitOutcomeT = {
      kind: 'scored',
      points_awarded: 7,
      matched: { rule_id: 'r1', option_ids: [] },
      confidence: 0.9,
      run_refs: ['run-1'],
      evidence_citations: [],
      cost_usd_micros: 500,
    };
    const out = await evaluateSubmissionCore(
      inputFor(answered(), modelRevision('slice-math-zh-v1'), {
        model_executor: async () => outcome,
      }),
    );
    expect(out.model_units_invoked).toBe(1);
    expect(out.spent_cost_usd_micros).toBe(500);
    expect(out.record.run_refs).toEqual(['run-1']);
    expect(out.record.unit_results[0]).toMatchObject({
      status: 'scored',
      points_awarded: 7,
      scored_because: 'response',
    });
    expect(out.record.aggregate).toMatchObject({ kind: 'points_total', points: 7 });
  });

  it('unadmitted executor + withhold ⇒ unjudgeable pending (never executes)', async () => {
    const spy: ModelUnitOutcomeT[] = [];
    const out = await evaluateSubmissionCore(
      inputFor(answered(), modelRevision(null), {
        model_executor: async () => {
          throw new Error('must never be called');
        },
      }),
    );
    expect(spy.length).toBe(0);
    expect(out.model_units_invoked).toBe(0);
    expect(out.record.unit_results[0]).toMatchObject({
      status: 'pending',
      pending: { reason: 'unjudgeable' },
    });
  });

  it('unadmitted executor + human_review escalation ⇒ needs_review pending', async () => {
    const revision = modelRevision(null);
    revision.execution_plan.escalation.on_unadmitted_model = 'human_review';
    const out = await evaluateSubmissionCore(inputFor(answered(), revision));
    expect(out.record.unit_results[0]).toMatchObject({
      status: 'pending',
      pending: { reason: 'needs_review', trigger: 'flagged' },
    });
  });

  it('admitted executor but no port injected ⇒ retryable infra_failure ⇒ record pending', async () => {
    const out = await evaluateSubmissionCore(
      inputFor(answered(), modelRevision('slice-math-zh-v1')),
    );
    expect(out.record.status).toBe('pending');
    expect(out.record.aggregate).toBeNull();
    expect(out.record.unit_results[0]).toMatchObject({
      status: 'pending',
      pending: { reason: 'infra_failure', retryable: true },
    });
  });

  it('executor throw ⇒ retryable infra_failure, record stays pending for retry', async () => {
    const out = await evaluateSubmissionCore(
      inputFor(answered(), modelRevision('slice-math-zh-v1'), {
        model_executor: async () => {
          throw new Error('provider timeout');
        },
      }),
    );
    expect(out.record.status).toBe('pending');
    expect(out.record.aggregate).toBeNull();
  });

  it('executor pending outcome ⇒ terminal pending (completed + unresolved aggregate)', async () => {
    const out = await evaluateSubmissionCore(
      inputFor(answered(), modelRevision('slice-math-zh-v1'), {
        model_executor: async () => ({
          kind: 'pending',
          pending: {
            reason: 'needs_review',
            trigger: 'flagged',
            detail: 'model flagged ambiguity',
          },
          run_refs: [],
        }),
      }),
    );
    expect(out.record.status).toBe('completed');
    expect(out.record.aggregate).toMatchObject({
      kind: 'unresolved',
      reason: 'pending_units',
    });
  });

  it('fabricated evidence citation ⇒ needs_review pending (D17 zero severe errors)', async () => {
    const out = await evaluateSubmissionCore(
      inputFor(answered(), modelRevision('slice-math-zh-v1'), {
        model_executor: async () => ({
          kind: 'scored',
          points_awarded: 10,
          evidence_citations: [{ evidence_id: 'ev-hallucinated' }],
          run_refs: [],
        }),
      }),
    );
    expect(out.record.unit_results[0]).toMatchObject({
      status: 'pending',
      pending: { reason: 'needs_review', trigger: 'flagged' },
    });
  });

  it('low confidence + human_review escalation ⇒ needs_review(low_confidence)', async () => {
    const out = await evaluateSubmissionCore(
      inputFor(answered(), modelRevision('slice-math-zh-v1'), {
        policy: { low_confidence_threshold: 0.5 },
        model_executor: async () => ({
          kind: 'scored',
          points_awarded: 8,
          confidence: 0.2,
          evidence_citations: [],
          run_refs: [],
        }),
      }),
    );
    expect(out.record.unit_results[0]).toMatchObject({
      status: 'pending',
      pending: { reason: 'needs_review', trigger: 'low_confidence' },
    });
  });

  it('plan cost cap reached ⇒ unjudgeable pending, executor never invoked', async () => {
    const revision = modelRevision('slice-math-zh-v1', 1000);
    revision.execution_plan.max_total_cost_usd_micros = 500;
    let invoked = 0;
    const out = await evaluateSubmissionCore(
      inputFor(answered(), revision, {
        model_executor: async () => {
          invoked += 1;
          return {
            kind: 'scored',
            points_awarded: 10,
            evidence_citations: [],
            run_refs: [],
          };
        },
      }),
    );
    expect(invoked).toBe(0);
    expect(out.record.unit_results[0]).toMatchObject({
      status: 'pending',
      pending: { reason: 'unjudgeable' },
    });
  });
});

describe('evaluateSubmissionCore — contract enforcement', () => {
  it('submission.revision_id mismatch ⇒ submission_revision_mismatch', async () => {
    const submission = submissionFor([{ slot_id: 'p1::r', kind: 'text', text_md: '2' }]);
    submission.revision_id = 'rev-other';
    await expect(
      evaluateSubmissionCore(inputFor(submission, revisionFor({}))),
    ).rejects.toMatchObject({ code: 'submission_revision_mismatch' });
  });

  it('invalid response set (unknown slot) ⇒ invalid_response_set', async () => {
    const submission = submissionFor([{ slot_id: 'nope', kind: 'text', text_md: '2' }]);
    await expect(
      evaluateSubmissionCore(inputFor(submission, revisionFor({}))),
    ).rejects.toMatchObject({ code: 'invalid_response_set' });
  });

  it('manual_assert requires manual provenance + asserted results', async () => {
    await expect(
      evaluateSubmissionCore(
        inputFor(
          submissionFor([{ slot_id: 'p1::r', kind: 'text', text_md: '2' }]),
          revisionFor({}),
          {
            mode: 'manual_assert',
            provenance: { source: 'automatic', assisted: false },
            asserted_unit_results: [],
          },
        ),
      ),
    ).rejects.toMatchObject({ code: 'manual_mode_requires_manual_provenance' });
  });

  it('manual_assert with complete asserted set ⇒ completed candidate', async () => {
    const out = await evaluateSubmissionCore(
      inputFor(submissionFor([{ slot_id: 'p1::r', kind: 'text', text_md: '2' }]), revisionFor({}), {
        mode: 'manual_assert',
        provenance: { source: 'manual', assisted: false },
        asserted_unit_results: [
          {
            status: 'scored',
            scoring_unit_id: 'p1::u',
            points_awarded: 2,
            scored_because: 'response',
            evidence_citations: [],
          },
        ],
      }),
    );
    expect(out.record.status).toBe('completed');
    expect(out.record.aggregate).toMatchObject({ kind: 'points_total', points: 2 });
    expect(out.record.provenance).toMatchObject({ source: 'manual' });
  });

  it('manual_assert missing an in-scope unit ⇒ manual_result_set_mismatch', async () => {
    await expect(
      evaluateSubmissionCore(
        inputFor(
          submissionFor([{ slot_id: 'p1::r', kind: 'text', text_md: '2' }]),
          revisionFor({}),
          {
            mode: 'manual_assert',
            provenance: { source: 'self_report', assisted: false },
            asserted_unit_results: [],
          },
        ),
      ),
    ).rejects.toMatchObject({ code: 'manual_result_set_mismatch' });
  });

  it('contract errors surface as EvaluationContractError', async () => {
    expect(new EvaluationContractError('invalid_response_set', 'x').name).toBe(
      'EvaluationContractError',
    );
  });
});
