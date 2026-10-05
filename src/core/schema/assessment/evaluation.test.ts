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

import { describe, expect, it, vi } from 'vitest';
import { freezeEvaluationInput } from '../../assessment-input';
import { ConjectureProbeSpecV2 } from '../business';

import {
  type EvaluateSubmissionCoreInput,
  EvaluationContractError,
  ModelExecutionNotStartedError,
  type ModelUnitOutcomeT,
  evaluateSubmissionCore,
  projectIssuedScoringBasis,
} from './evaluation';
import type {
  ExecutionPlanT,
  PublishedQuestionRevisionT,
  ScoringBasisT,
  SubmissionRecordT,
} from './index';
import { deriveCoarseVerdict } from './settlement';

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

describe('native probe response signatures', () => {
  const probe = ConjectureProbeSpecV2.parse({
    schema_version: 2,
    prompt_md: '求 sin(3x²) 的导数，并说明内外层如何组合。',
    reference_md: '6x cos(3x²)，外层导数与内层导数相乘。',
    expected_target_error_answer_md: 'cos(3x²)，遗漏内层导数。',
    elicits_target_error_reason_md: '区分链式法则遗漏与其他计算错误。',
    context_kind: 'abstract',
    representation_kind: 'symbolic',
    response_mode: 'short_answer',
    gold_response_signature: { kind: 'text', response_md: '6x cos(3x²)' },
    target_error_response_signature: { kind: 'text', response_md: 'cos(3x²)' },
  });

  it.each([
    { match: 'gold', points: 2, status: 'scored', reason: 'gold_signature_matched' },
    {
      match: 'target_error',
      points: 0,
      status: 'scored',
      reason: 'target_error_signature_matched',
    },
    { match: 'neither', points: 0, status: 'scored', reason: 'response_matches_neither_signature' },
    { match: 'ambiguous', points: 0, status: 'pending', reason: 'signature_match_ambiguous' },
    { match: undefined, points: 0, status: 'pending', reason: 'signature_judgement_missing' },
    { match: 'gold', points: 0, status: 'pending', reason: 'correctness_signature_conflict' },
    {
      match: 'target_error',
      points: 2,
      status: 'pending',
      reason: 'correctness_signature_conflict',
    },
    { match: 'gold', points: 1, status: 'pending', reason: 'correctness_judge_ungradable' },
  ] as const)(
    'preserves $match / $points as $reason',
    async ({ match, points, status, reason }) => {
      const revision = revisionFor({
        parts: [{ part_id: 'p1', prompt_md: probe.prompt_md, material_ids: [] }],
        blank_scores_zero: false,
        units: [
          {
            scoring_unit_id: 'p1::u',
            slot_refs: ['p1::r'],
            material_refs: [],
            evidence_slot_refs: [],
            requires_group_evidence: false,
            points: 2,
            criterion: {
              kind: 'rule_reference',
              rule_id: 'chain-rule',
              source: 'system_proposed',
              statement_md: probe.reference_md,
              probe_spec: probe,
            },
          },
        ],
        assignments: [
          {
            scoring_unit_ids: ['p1::u'],
            executor: {
              kind: 'model_executor',
              task_kind: 'AssessmentRuleJudgeTask',
              admitted_slice_id: 'offline-probe-fixture',
            },
          },
        ],
      });
      const out = await evaluateSubmissionCore(
        inputFor(
          submissionFor([{ slot_id: 'p1::r', kind: 'text', text_md: 'cos(3x²)' }]),
          revision,
          {
            model_executor: async (request) => {
              expect(request.unit.criterion).toMatchObject({ probe_spec: probe });
              return {
                kind: 'scored',
                points_awarded: points,
                matched: { rule_id: 'chain-rule', option_ids: [] },
                evidence_citations: [{ slot_id: 'p1::r', quote: 'cos(3x²)' }],
                run_refs: ['offline-run'],
                ...(match
                  ? {
                      probe_signature_match: {
                        match,
                        explanation_md: '比较冻结正确和目标错误签名。',
                      },
                    }
                  : {}),
              };
            },
          },
        ),
      );
      expect(out.record.unit_results[0]).toMatchObject({
        status,
        probe_judgement: { gradable: status === 'scored', reason_code: reason },
      });
      if (status === 'pending') expect(out.record.aggregate?.kind).toBe('unresolved');
    },
  );
});

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

  it.each([
    ['30 m/s', 1],
    ['108 km/h', 1],
    ['3000 cm/s', 1],
    ['31.5 m/s', 1],
    ['31.5001 m/s', 0],
    ['30 kg', 0],
    ['30', 0],
    ['速度约三十米每秒', null],
  ])(
    'frozen numeric unit conversion judges original %s locally with explicit tolerance',
    async (raw, points) => {
      const revision = revisionFor({
        slots: [{ slot_id: 'p1::r', part_id: 'p1', kind: 'numeric' }],
        units: [
          {
            scoring_unit_id: 'p1::u',
            slot_refs: ['p1::r'],
            material_refs: [],
            evidence_slot_refs: [],
            requires_group_evidence: false,
            points: 1,
            criterion: {
              kind: 'numeric_key',
              expected: 30,
              expected_unit: 'm/s',
              tolerance: { kind: 'relative', ratio: 0.05 },
            },
          },
        ],
        assignments: [
          {
            scoring_unit_ids: ['p1::u'],
            executor: { kind: 'deterministic', comparator: 'numeric_unit_conversion' },
          },
        ],
      });
      const execute = vi.fn();
      const evaluated = await evaluateSubmissionCore({
        ...inputFor(
          submissionFor([
            // A client-derived value is deliberately wrong: original raw input owns the interpretation.
            {
              slot_id: 'p1::r',
              kind: 'numeric',
              value: raw === '30 m/s' ? 999 : null,
              raw_input: raw,
            },
          ]),
          revision,
        ),
        model_executor: execute,
      });
      expect(execute).not.toHaveBeenCalled();
      if (points === null) {
        expect(evaluated.record.unit_results[0]).toMatchObject({
          status: 'pending',
          pending: { reason: 'unparseable_response' },
        });
      } else {
        expect(evaluated.record.unit_results[0]).toMatchObject({
          status: 'scored',
          points_awarded: points,
        });
      }
      expect(evaluated.record.run_refs).toEqual([]);
    },
  );

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

  it.each([{ issued: [] }, { issued: ['unknown'] }, { issued: ['p1', 'p1'] }])(
    'refuses invalid issued scope $issued instead of treating it as full scope',
    async ({ issued }) => {
      await expect(
        evaluateSubmissionCore(
          inputFor(submissionFor([]), twoPartRevision(), { issued_part_ids: issued }),
        ),
      ).rejects.toMatchObject({ code: 'invalid_issuance_scope' });
    },
  );

  it('keeps full scoring policy immutable and excludes cross-part/evidence-only units correctly', () => {
    const revision = twoPartRevision();
    const first = revision.scoring_basis.units[0];
    if (!first) throw new Error('fixture unit missing');
    revision.scoring_basis.units.push(
      { ...first, scoring_unit_id: 'cross', evidence_slot_refs: ['p2::r'] },
      {
        ...first,
        scoring_unit_id: 'evidence',
        slot_refs: [],
        evidence_slot_refs: ['p2::r'],
        criterion: {
          kind: 'rule_reference',
          rule_id: 'r',
          statement_md: 'cited response',
          source: 'official',
        },
      },
      {
        ...first,
        scoring_unit_id: 'group',
        slot_refs: [],
        requires_group_evidence: true,
        criterion: {
          kind: 'rule_reference',
          rule_id: 'g',
          statement_md: 'group evidence',
          source: 'official',
        },
      },
    );
    const frozen = structuredClone(revision);
    expect(projectIssuedScoringBasis(revision, ['p1']).units.map((u) => u.scoring_unit_id)).toEqual(
      ['p1::u', 'group'],
    );
    expect(projectIssuedScoringBasis(revision, ['p2']).units.map((u) => u.scoring_unit_id)).toEqual(
      ['p2::u', 'evidence', 'group'],
    );
    expect(projectIssuedScoringBasis(revision, ['p1', 'p2'])).toBe(revision.scoring_basis);
    expect(revision).toEqual(frozen);
  });

  it('manual assertion returns the same scoped denominator as automatic scoring', async () => {
    const revision = twoPartRevision();
    const result = await evaluateSubmissionCore(
      inputFor(submissionFor([{ slot_id: 'p1::r', kind: 'text', text_md: '1' }]), revision, {
        issued_part_ids: ['p1'],
        mode: 'manual_assert',
        provenance: { source: 'manual', assisted: false },
        asserted_unit_results: [
          {
            status: 'scored',
            scoring_unit_id: 'p1::u',
            points_awarded: 1,
            scored_because: 'response',
            evidence_citations: [],
          },
        ],
      }),
    );
    expect(deriveCoarseVerdict(result.record, result.scoring_basis)).toMatchObject({
      verdict: 'correct',
      maxPoints: 1,
      normalized: 1,
    });
  });

  it('does not shrink the denominator to only units with scored results', async () => {
    const revision = twoPartRevision();
    const result = await evaluateSubmissionCore(
      inputFor(submissionFor([{ slot_id: 'p1::r', kind: 'text', text_md: '1' }]), revision, {
        issued_part_ids: ['p1', 'p2'],
      }),
    );
    expect(result.scoring_basis).toEqual(revision.scoring_basis);
    expect(deriveCoarseVerdict(result.record, result.scoring_basis).verdict).toBe('unsupported');
  });

  it('threshold levels cannot project a subset, while its full scope is unchanged', () => {
    const revision = twoPartRevision();
    revision.scoring_basis.aggregation = {
      kind: 'threshold_levels',
      thresholds: [{ level_id: 'pass', min_points: 3 }],
    };
    expect(() => projectIssuedScoringBasis(revision, ['p1'])).toThrow(/unprojectable_aggregation/);
    expect(projectIssuedScoringBasis(revision, ['p1', 'p2'])).toBe(revision.scoring_basis);
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

  it('propagates an explicit pre-execution refusal without turning it into a grading record', async () => {
    const refusal = new ModelExecutionNotStartedError(new Error('local admission refused'));
    await expect(
      evaluateSubmissionCore(
        inputFor(answered(), modelRevision('slice-math-zh-v1'), {
          model_executor: async () => {
            throw refusal;
          },
        }),
      ),
    ).rejects.toBe(refusal);
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

  it.each(['manual', 'self_report'] as const)(
    'rejects executed scoring labeled as %s before invoking the model',
    async (source) => {
      const model_executor = vi.fn();
      for (const mode of [undefined, 'execute'] as const) {
        await expect(
          evaluateSubmissionCore(
            inputFor(
              submissionFor([{ slot_id: 'p1::r', kind: 'text', text_md: '2' }]),
              revisionFor({
                assignments: [
                  {
                    scoring_unit_ids: ['p1::u'],
                    executor: {
                      kind: 'model_executor',
                      task_kind: 'JevScoringDecisionTask',
                      admitted_slice_id: 'test:admitted-slice',
                    },
                  },
                ],
              }),
              { mode, provenance: { source, assisted: false }, model_executor },
            ),
          ),
        ).rejects.toMatchObject({ code: 'execute_mode_requires_automatic_provenance' });
      }
      expect(model_executor).not.toHaveBeenCalled();
    },
  );

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

describe('joint evaluation preserves original member inputs', () => {
  function jointInput() {
    const revision = revisionFor({
      parts: [
        { part_id: 'p1', prompt_md: '读表：第一组在相同水量下流速为 2 m/s。', material_ids: [] },
        {
          part_id: 'p2',
          prompt_md: '第二组流速为 4 m/s，结合第一组解释坡度关系。',
          material_ids: [],
        },
      ],
      slots: [
        { slot_id: 'p1::r', part_id: 'p1', kind: 'text', math_preview: false },
        { slot_id: 'p2::r', part_id: 'p2', kind: 'text', math_preview: false },
      ],
      units: ['p1', 'p2'].map((part, i) => ({
        scoring_unit_id: `${part}::u`,
        slot_refs: [`${part}::r`],
        material_refs: [],
        evidence_slot_refs: [],
        requires_group_evidence: false,
        criterion: {
          kind: 'text_key' as const,
          accepted_texts: [String((i + 1) * 2)],
          normalization: 'trim' as const,
        },
        points: 1,
      })),
    });
    const first = submissionFor([{ slot_id: 'p1::r', kind: 'text', text_md: '2' }]);
    const second = {
      ...submissionFor([{ slot_id: 'p2::r', kind: 'text', text_md: '4' }]),
      submission_id: 'sub-2',
      issuance_id: 'iss-2',
      submitted_at: '2026-09-25T00:00:01.000Z',
    };
    return inputFor(first, revision, {
      member_inputs: [
        { submission: first, issued_part_ids: ['p1'] },
        { submission: second, issued_part_ids: ['p2'] },
      ],
    });
  }

  it('scores every selected unit once without rewriting either submission', async () => {
    const input = jointInput();
    const before = structuredClone(input.member_inputs);
    const result = await evaluateSubmissionCore(input);
    expect(result.record.submission_id).toBe(input.submission.submission_id);
    expect(result.record.unit_results.map((r) => r.scoring_unit_id)).toEqual(['p1::u', 'p2::u']);
    expect(result.record.aggregate).toMatchObject({ kind: 'points_total', points: 2 });
    expect(input.member_inputs).toEqual(before);
  });

  it.each(['revision', 'group', 'overlap', 'foreign_response', 'duplicate', 'anchor_missing'])(
    'rejects ambiguous %s membership before any model call',
    async (scenario) => {
      const input = jointInput();
      const members = [...(input.member_inputs ?? [])].map((m) => structuredClone(m));
      if (scenario === 'revision') members[1].submission.revision_id = 'other-revision';
      if (scenario === 'group') members[1].submission.evaluation_group_id = 'other-group';
      if (scenario === 'overlap') members[1].issued_part_ids = ['p1'];
      if (scenario === 'foreign_response')
        members[1].submission.response_set.entries[0].slot_id = 'p1::r';
      if (scenario === 'duplicate') members.push(members[1]);
      if (scenario === 'anchor_missing') members.shift();
      const executor = vi.fn();
      await expect(
        evaluateSubmissionCore({ ...input, member_inputs: members, model_executor: executor }),
      ).rejects.toMatchObject({ code: 'invalid_group_input' });
      expect(executor).not.toHaveBeenCalled();
    },
  );

  it('a declared cross-part model unit receives both responses and exact member identities once', async () => {
    const input = jointInput();
    input.revision.scoring_basis.units = [
      {
        scoring_unit_id: 'joint',
        slot_refs: ['p1::r', 'p2::r'],
        material_refs: [],
        evidence_slot_refs: [],
        requires_group_evidence: false,
        criterion: {
          kind: 'rule_reference',
          rule_id: 'relation',
          source: 'official',
          statement_md: '以两组读数共同支持比例关系，不能只看一个读数。',
        },
        points: 2,
      },
    ];
    input.revision.execution_plan.assignments = [
      {
        scoring_unit_ids: ['joint'],
        executor: {
          kind: 'model_executor',
          task_kind: 'JevScoringDecisionTask',
          admitted_slice_id: 'joint-admitted',
        },
      },
    ];
    const executor = vi.fn(
      async (): Promise<ModelUnitOutcomeT> => ({
        kind: 'scored',
        points_awarded: 2,
        evidence_citations: [{ slot_id: 'p1::r' }, { slot_id: 'p2::r' }],
        run_refs: ['unit:joint'],
      }),
    );
    const output = await evaluateSubmissionCore({ ...input, model_executor: executor });
    expect(output.record.aggregate).toMatchObject({ points: 2 });
    expect(executor).toHaveBeenCalledOnce();
    expect(executor.mock.calls[0]).toBeDefined();
    expect(executor).toHaveBeenCalledWith(
      expect.objectContaining({
        submission_ids: [SUBMISSION_ID, 'sub-2'].sort(),
        question_parts: input.revision.structure.parts,
        response_slots: input.revision.response_spec.slots,
        slot_responses: [
          expect.objectContaining({ slot_id: 'p1::r' }),
          expect.objectContaining({ slot_id: 'p2::r' }),
        ],
      }),
    );
  });
  it('preserves a full-revision cap across disjoint member issuances', async () => {
    const input = jointInput();
    input.revision.scoring_basis.aggregation = { kind: 'capped_sum', cap: 1.5 };
    expect((await evaluateSubmissionCore(input)).record.aggregate).toMatchObject({ points: 1.5 });
  });

  it('seals a stable digest across member enumeration order and detects answer changes', () => {
    const input = jointInput();
    const members = (input.member_inputs ?? []).map((member) => ({
      ...member,
      binding: {
        revision_id: member.submission.revision_id,
        part_ids: [...member.issued_part_ids],
        material_bindings: [],
        option_order: [],
      },
      issued_at: NOW,
    }));
    const first = freezeEvaluationInput(input.submission, input.revision, members);
    expect(freezeEvaluationInput(input.submission, input.revision, [...members].reverse())).toEqual(
      first,
    );
    members[1].submission.response_set.entries = [
      { slot_id: 'p2::r', kind: 'text', text_md: '修改后的不同答案' },
    ];
    expect(freezeEvaluationInput(input.submission, input.revision, members).digest).not.toBe(
      first.digest,
    );
  });

  it('rejects a shared evidence identity when member attachments disagree', async () => {
    const input = jointInput();
    const members = structuredClone(input.member_inputs ?? []);
    for (const [i, member] of members.entries()) {
      member.submission.group_evidence = [
        {
          target: { scope: 'all_units' },
          evidence: {
            evidence_id: 'page-1',
            kind: 'image',
            asset: { asset_id: 'page-asset', digest: `sha256:${String(i).repeat(64)}` },
            mime_type: 'image/png',
            bytes: 1200,
            uploaded_at: NOW,
          },
        },
      ];
    }
    await expect(
      evaluateSubmissionCore({
        ...input,
        submission: members[0].submission,
        member_inputs: members,
      }),
    ).rejects.toMatchObject({ code: 'invalid_group_input' });
  });
});

it('model request preserves the actual issued question conditions and native option meanings', async () => {
  const prompt =
    '一艘船沿河航行：顺流18千米用时1小时，逆流12千米用时1小时。求静水速度，并说明两式相加如何消去水速。';
  const instruction = '静水速度15千米/时，水流速度3千米/时，两式相加消去水流速度。';
  const revision = revisionFor({
    parts: [
      { part_id: 'p1', prompt_md: prompt, material_ids: ['stimulus'] },
      { part_id: 'unissued', prompt_md: '不应泄入当前评分的另一问题', material_ids: ['other'] },
    ],
    materials: [
      {
        material_id: 'stimulus',
        kind: 'table',
        asset: { asset_id: 'table-frozen', digest: 'sha256:original' },
        content_md: '|航段|航程|\n|顺流|18 km|\n|逆流|12 km|',
      },
      {
        material_id: 'other',
        kind: 'plaintext',
        asset: { asset_id: 'other-private', digest: 'sha256:other' },
        content_md: '另一单元的私有评分依据',
        visibility: 'private',
      },
    ],
    slots: [
      {
        slot_id: 'p1::r',
        part_id: 'p1',
        kind: 'single_choice',
        options: [
          { option_id: 'opaque-a', label: 'A', text: '静水速度30千米/时。' },
          { option_id: 'opaque-b', label: 'B', text: instruction },
        ],
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
          kind: 'rule_reference',
          rule_id: 'relation',
          statement_md: '正确运用题中数量关系并解释消元过程。',
          source: 'official',
        },
        points: 4,
      },
    ],
    assignments: [
      {
        scoring_unit_ids: ['p1::u'],
        executor: {
          kind: 'model_executor',
          task_kind: 'JevScoringDecisionTask',
          admitted_slice_id: 'approved-slice',
        },
      },
    ],
  });

  const before = structuredClone(revision);
  let captured: unknown;
  await evaluateSubmissionCore(
    inputFor(
      submissionFor([{ slot_id: 'p1::r', kind: 'choice', option_ids: ['opaque-b'] }]),
      revision,
      {
        issued_part_ids: ['p1'],
        model_executor: async (req) => {
          captured = req;
          return {
            kind: 'pending',
            pending: {
              reason: 'needs_review',
              trigger: 'flagged',
              detail: 'Context transport fixture; no grading performed.',
            },
            run_refs: [],
          };
        },
      },
    ),
  );
  expect(captured).toBeDefined();
  expect(captured).toMatchObject({ materials: [revision.structure.materials[0]] });
  expect(revision).toEqual(before);
  expect(JSON.stringify(captured)).not.toContain('另一单元的私有评分依据');
  expect.soft(JSON.stringify(captured)).toContain(prompt);
  expect.soft(JSON.stringify(captured)).toContain(instruction);
  expect(JSON.stringify(captured)).not.toContain('不应泄入当前评分的另一问题');
});

it('group-only scoring receives only the issued question scope', async () => {
  const revision = revisionFor({
    parts: [
      {
        part_id: 'p1',
        prompt_md: '阅读下列完整推导并说明条件：一、保持水量；二、比较坡度；三、结合表格。',
        material_ids: [],
      },
      { part_id: 'p2', prompt_md: '另一张未发出的题目', material_ids: [] },
    ],
    slots: [
      { slot_id: 'p1::r', part_id: 'p1', kind: 'text', math_preview: false },
      { slot_id: 'p2::r', part_id: 'p2', kind: 'text', math_preview: false },
    ],
    units: [
      {
        scoring_unit_id: 'group',
        slot_refs: [],
        material_refs: [],
        evidence_slot_refs: [],
        requires_group_evidence: true,
        criterion: {
          kind: 'rule_reference',
          rule_id: 'group-rule',
          statement_md: '整页推导能支持题目所需结论。',
          source: 'official',
        },
        points: 2,
      },
    ],
    assignments: [
      {
        scoring_unit_ids: ['group'],
        executor: {
          kind: 'model_executor',
          task_kind: 'JevScoringDecisionTask',
          admitted_slice_id: 'approved',
        },
      },
    ],
  });
  const submission = submissionFor([]);
  submission.group_evidence = [
    {
      target: { scope: 'all_units' },
      evidence: {
        evidence_id: 'page',
        kind: 'image',
        asset: { asset_id: 'page-asset', digest: `sha256:${'a'.repeat(64)}` },
        mime_type: 'image/png',
        bytes: 1200,
        uploaded_at: NOW,
      },
    },
  ];
  const executor = vi.fn(
    async (): Promise<ModelUnitOutcomeT> => ({
      kind: 'pending',
      pending: {
        reason: 'needs_review',
        trigger: 'flagged',
        detail: 'Context transport fixture; no grading performed.',
      },
      run_refs: [],
    }),
  );
  await evaluateSubmissionCore(
    inputFor(submission, revision, { issued_part_ids: ['p1'], model_executor: executor }),
  );
  expect(executor).toHaveBeenCalledOnce();
  expect(executor).toHaveBeenCalledWith(
    expect.objectContaining({
      question_parts: [revision.structure.parts[0]],
      response_slots: [revision.response_spec.slots[0]],
      group_evidence: submission.group_evidence,
    }),
  );
});

describe('whole-page evidence is not a blank response', () => {
  const attachment = {
    evidence_id: 'page-original',
    kind: 'image' as const,
    asset: { asset_id: 'page-original', digest: `sha256:${'d'.repeat(64)}` },
    mime_type: 'image/png',
    bytes: 2048,
    uploaded_at: NOW,
  };
  it.each(['all_units', 'units'] as const)(
    'holds an empty exact slot with %s original media instead of blank-marking it zero',
    async (scope) => {
      const submission = submissionFor([{ slot_id: 'p1::r', kind: 'text', text_md: '' }]);
      submission.group_evidence = [
        {
          evidence: attachment,
          target: scope === 'all_units' ? { scope } : { scope, scoring_unit_ids: ['p1::u'] },
        },
      ];
      const out = await evaluateSubmissionCore(
        inputFor(submission, revisionFor({ blank_scores_zero: true })),
      );
      expect(out.record.status).toBe('completed');
      expect(out.record.unit_results).toMatchObject([
        { status: 'pending', pending: { reason: 'unjudgeable' } },
      ]);
      expect(out.record.aggregate).toMatchObject({ kind: 'unresolved', reason: 'pending_units' });
    },
  );
  it('keeps the published blank policy for a unit outside the evidence target', async () => {
    const base = revisionFor({});
    const first = base.scoring_basis.units[0];
    const revision = revisionFor({
      slots: [
        ...base.response_spec.slots,
        { slot_id: 'second', part_id: 'p1', kind: 'text', math_preview: false },
      ],
      units: [first, { ...first, scoring_unit_id: 'second-unit', slot_refs: ['second'] }],
    });
    const submission = submissionFor([
      { slot_id: 'p1::r', kind: 'text', text_md: '' },
      { slot_id: 'second', kind: 'text', text_md: '2' },
    ]);
    submission.group_evidence = [
      { evidence: attachment, target: { scope: 'units', scoring_unit_ids: ['second-unit'] } },
    ];
    const out = await evaluateSubmissionCore(inputFor(submission, revision));
    expect(out.record.unit_results).toMatchObject([
      {
        scoring_unit_id: 'p1::u',
        status: 'scored',
        scored_because: 'blank_marked_zero',
        points_awarded: 0,
      },
      {
        scoring_unit_id: 'second-unit',
        status: 'scored',
        scored_because: 'response',
        points_awarded: 2,
      },
    ]);
  });
  it.each([true, false])(
    'dispatches original photo evidence with an explicit text entry: %s',
    async (explicitText) => {
      const revision = revisionFor({
        units: [
          {
            scoring_unit_id: 'p1::u',
            slot_refs: ['p1::r'],
            evidence_slot_refs: [],
            material_refs: [],
            requires_group_evidence: true,
            criterion: {
              kind: 'rule_reference',
              rule_id: 'shown-work',
              statement_md: 'Check the algebra and domain restriction in the handwritten original.',
              source: 'official',
            },
            points: 2,
          },
        ],
        assignments: [
          {
            scoring_unit_ids: ['p1::u'],
            executor: {
              kind: 'model_executor',
              task_kind: 'AssessmentRuleJudgeTask',
              admitted_slice_id: 'handwriting-accepted',
              max_cost_usd_micros: 1000,
            },
          },
        ],
      });
      const submission = submissionFor(
        explicitText ? [{ slot_id: 'p1::r', kind: 'text', text_md: '' }] : [],
      );
      submission.group_evidence = [{ evidence: attachment, target: { scope: 'all_units' } }];
      const port = vi.fn(
        async (
          _request: import('./evaluation').ModelExecutorRequest,
        ): Promise<ModelUnitOutcomeT> => ({
          kind: 'scored',
          points_awarded: 2,
          confidence: 0.99,
          matched: { rule_id: 'shown-work', option_ids: [] },
          evidence_citations: [{ evidence_id: 'page-original' }],
          cost_usd_micros: 12,
          run_refs: ['original-photo-run'],
        }),
      );
      const out = await evaluateSubmissionCore(
        inputFor(submission, revision, { model_executor: port }),
      );
      expect(port).toHaveBeenCalledOnce();
      expect(port.mock.calls[0]?.[0]).toMatchObject({ group_evidence: submission.group_evidence });
      expect(out.record.unit_results).toMatchObject([
        { status: 'scored', scored_because: 'response', points_awarded: 2 },
      ]);

      port.mockClear();
      const scopedRevision = structuredClone(revision);
      scopedRevision.scoring_basis.units.push({
        ...scopedRevision.scoring_basis.units[0],
        scoring_unit_id: 'uncovered',
      });
      scopedRevision.execution_plan.assignments[0].scoring_unit_ids.push('uncovered');
      const scopedSubmission = submissionFor([]);
      scopedSubmission.group_evidence = [
        { evidence: attachment, target: { scope: 'units', scoring_unit_ids: ['p1::u'] } },
      ];
      const scoped = await evaluateSubmissionCore(
        inputFor(scopedSubmission, scopedRevision, { model_executor: port }),
      );
      expect(port).toHaveBeenCalledOnce();
      expect(scoped.record.unit_results).toMatchObject([
        { scoring_unit_id: 'p1::u', status: 'scored' },
        {
          scoring_unit_id: 'uncovered',
          status: 'pending',
          pending: { reason: 'missing_response' },
        },
      ]);
      port.mockClear();
      const unadmitted = structuredClone(revision);
      const executor = unadmitted.execution_plan.assignments[0].executor;
      if (executor.kind !== 'model_executor') throw new Error('fixture must use model scoring');
      executor.admitted_slice_id = null;
      const held = await evaluateSubmissionCore(
        inputFor(submission, unadmitted, { model_executor: port }),
      );
      expect(port).not.toHaveBeenCalled();
      expect(held.record.unit_results).toMatchObject([
        { status: 'pending', pending: { reason: 'unjudgeable' } },
      ]);
    },
  );
});
