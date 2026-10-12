// YUK-1046 — ScoringBasis 契约测试：scoring unit 是唯一计分权威，
// 贡献恰好一次、无 slot+criterion+dimension 重复累加（grounding §4.4、D13）。

import { describe, expect, it } from 'vitest';

import { PracticeIssuanceDto, projectPracticeIssuance } from './dto';
import { evaluateSubmissionCore } from './evaluation';
import { type ScoredUnitResultT, type SubmissionRecordT, aggregateUnitResults } from './judgment';
import { ResponseSpec, type ResponseSpecT } from './response';
import {
  AssessmentIssuance,
  PublishedQuestionRevision,
  type PublishedQuestionRevisionT,
  deriveIssuanceBinding,
} from './revision';
import { ScoringBasis, type ScoringBasisT, type ScoringUnitCriterionT } from './scoring';
import { QuestionGroupStructure, type QuestionGroupStructureT } from './structure';

function fixture(): {
  spec: ResponseSpecT;
  structure: QuestionGroupStructureT;
  basis: ScoringBasisT;
} {
  const spec: ResponseSpecT = ResponseSpec.parse({
    slots: [
      {
        slot_id: 'mc',
        part_id: 'p1',
        kind: 'multi_choice',
        options: [
          { option_id: 'o1', label: 'A', text: '甲' },
          { option_id: 'o2', label: 'B', text: '乙' },
          { option_id: 'o3', label: 'C', text: '丙' },
          { option_id: 'o4', label: 'D', text: '丁' },
          { option_id: 'o5', label: 'E', text: '戊（第 5 个选项 —— 数量自由）' },
        ],
        min_select: 1,
        max_select: 3,
      },
      { slot_id: 'ans', part_id: 'p1', kind: 'numeric', unit_hint: 'm/s' },
      { slot_id: 'essay', part_id: 'p1', kind: 'open_response' },
    ],
  });
  const structure: QuestionGroupStructureT = QuestionGroupStructure.parse({
    group_id: 'grp_1',
    materials: [
      {
        material_id: 'mat_fig',
        kind: 'figure',
        asset: { asset_id: 'ast_fig', digest: 'sha256:fig' },
        alt_text: '斜面与小车的受力示意图',
      },
    ],
    parts: [
      {
        part_id: 'p1',
        prompt_md: '如图（mat_fig），求小车末速度并论述能量守恒的适用条件。',
        material_ids: ['mat_fig'],
      },
    ],
  });
  const basis: ScoringBasisT = ScoringBasis.parse({
    units: [
      {
        scoring_unit_id: 'u_choice',
        slot_refs: ['mc'],
        material_refs: [],
        evidence_slot_refs: [],
        criterion: { kind: 'option_set_key', accepted_option_ids: ['o1', 'o4'] },
        points: 4,
      },
      {
        scoring_unit_id: 'u_speed',
        slot_refs: ['ans'],
        material_refs: ['mat_fig'],
        evidence_slot_refs: [],
        criterion: {
          kind: 'numeric_key',
          expected: 9.8,
          tolerance: { kind: 'relative', ratio: 0.02 },
          expected_unit: 'm/s',
        },
        points: 3,
      },
      {
        scoring_unit_id: 'u_reasoning',
        slot_refs: ['essay'],
        material_refs: [],
        evidence_slot_refs: [],
        criterion: {
          kind: 'rule_reference',
          rule_id: 'rule_energy_1',
          statement_md:
            '论述须同时覆盖：①系统边界选取；②仅重力做功的条件；③至少一组能量转化实例。答出两点给一半分。',
          source: 'official',
        },
        points: 3,
      },
    ],
    aggregation: { kind: 'sum' },
    blank_scores_zero: true,
  });
  return { spec, structure, basis };
}

const scored = (
  scoring_unit_id: string,
  points_awarded: number,
  extra: Partial<ScoredUnitResultT> = {},
): ScoredUnitResultT => ({
  status: 'scored',
  scoring_unit_id,
  points_awarded,
  scored_because: 'response',
  evidence_citations: [],
  ...extra,
});

describe('aggregateUnitResults — 总分只聚合一次', () => {
  it('sums each unit exactly once (7 = 4 + 3 + 0 across three units)', () => {
    const { basis } = fixture();
    const outcome = aggregateUnitResults(basis, [
      scored('u_choice', 4),
      scored('u_speed', 3),
      scored('u_reasoning', 0, { scored_because: 'blank_marked_zero' }),
    ]);
    expect(outcome).toEqual({ kind: 'points_total', points: 7, policy: { kind: 'sum' } });
  });

  it('duplicate or missing unit results are result_set_mismatch — never silently averaged', () => {
    const { basis } = fixture();
    expect(aggregateUnitResults(basis, [scored('u_choice', 4), scored('u_choice', 2)]).kind).toBe(
      'unresolved',
    );
    expect(aggregateUnitResults(basis, [scored('u_choice', 4)]).kind).toBe('unresolved');
  });

  it('any pending unit blocks the aggregate with pending_units (no partial total)', () => {
    const { basis } = fixture();
    const outcome = aggregateUnitResults(basis, [
      scored('u_choice', 4),
      {
        status: 'pending',
        scoring_unit_id: 'u_speed',
        pending: { reason: 'missing_materials', material_ids: ['mat_fig'] },
      },
      scored('u_reasoning', 3),
    ]);
    expect(outcome.kind).toBe('unresolved');
    if (outcome.kind === 'unresolved') {
      expect(outcome.reason).toBe('pending_units');
      expect(outcome.detail).toContain('u_speed');
    }
  });

  it('capped_sum caps and threshold_levels maps bands', () => {
    const { basis } = fixture();
    const capped: ScoringBasisT = ScoringBasis.parse({
      ...basis,
      aggregation: { kind: 'capped_sum', cap: 5 },
    });
    expect(
      aggregateUnitResults(capped, [
        scored('u_choice', 4),
        scored('u_speed', 3),
        scored('u_reasoning', 3),
      ]),
    ).toMatchObject({ kind: 'points_total', points: 5 });

    const banded: ScoringBasisT = ScoringBasis.parse({
      ...basis,
      aggregation: {
        kind: 'threshold_levels',
        thresholds: [
          { level_id: 'pass', min_points: 4 },
          { level_id: 'full', min_points: 9 },
        ],
      },
    });
    expect(
      aggregateUnitResults(banded, [
        scored('u_choice', 4),
        scored('u_speed', 3),
        scored('u_reasoning', 0),
      ]),
    ).toMatchObject({ kind: 'level', level_id: 'pass' });
    // 低于一切档位：显式 no_mapping，不造总分。
    const belowAll: ScoringBasisT = ScoringBasis.parse({
      ...basis,
      aggregation: {
        kind: 'threshold_levels',
        thresholds: [{ level_id: 'pass', min_points: 99 }],
      },
    });
    const outcome = aggregateUnitResults(belowAll, [
      scored('u_choice', 0, { scored_because: 'blank_marked_zero' }),
      scored('u_speed', 0),
      scored('u_reasoning', 0),
    ]);
    expect(outcome.kind).toBe('unresolved');
  });

  it('P1-1: extra results are rejected, never silently ignored (even pending ones)', () => {
    const { basis } = fixture();
    const extra = aggregateUnitResults(basis, [
      scored('u_choice', 4),
      scored('u_speed', 3),
      scored('u_reasoning', 3),
      {
        status: 'pending',
        scoring_unit_id: 'u_ghost',
        pending: { reason: 'needs_review', trigger: 'flagged', detail: '' },
      },
    ]);
    expect(extra).toMatchObject({
      kind: 'unresolved',
      reason: 'result_set_mismatch',
      detail: "result for undeclared unit 'u_ghost'",
    });
  });

  it('P1-1: scores above the published unit max are invalid, not clamped', () => {
    const { basis } = fixture();
    const outcome = aggregateUnitResults(basis, [
      scored('u_choice', 99),
      scored('u_speed', 3),
      scored('u_reasoning', 3),
    ]);
    expect(outcome).toMatchObject({
      kind: 'unresolved',
      reason: 'invalid_result',
      detail: "unit 'u_choice' awarded 99 above published max 4",
    });
  });

  it('P1-1: blank_marked_zero is invalid when basis.blank_scores_zero=false', () => {
    const { basis } = fixture();
    const strict: ScoringBasisT = ScoringBasis.parse({ ...basis, blank_scores_zero: false });
    const outcome = aggregateUnitResults(strict, [
      scored('u_choice', 0, { scored_because: 'blank_marked_zero' }),
      scored('u_speed', 3),
      scored('u_reasoning', 3),
    ]);
    expect(outcome).toMatchObject({
      kind: 'unresolved',
      reason: 'invalid_result',
      detail: "unit 'u_choice' scored blank as zero but basis.blank_scores_zero=false",
    });
  });

  it('P1-1: a missing weight fails closed instead of defaulting to 0', () => {
    const { basis } = fixture();
    const holey: ScoringBasisT = ScoringBasis.parse({
      ...basis,
      aggregation: { kind: 'weighted_sum', weights: { u_choice: 1, u_speed: 0.5 } }, // 缺 u_reasoning
    });
    const outcome = aggregateUnitResults(holey, [
      scored('u_choice', 4),
      scored('u_speed', 3),
      scored('u_reasoning', 3),
    ]);
    expect(outcome).toMatchObject({
      kind: 'unresolved',
      reason: 'invalid_result',
      detail: "weighted_sum is missing a weight for unit 'u_reasoning'",
    });
  });

  it('P1-1: a basis with duplicate unit ids is invalid at the aggregation boundary too', () => {
    const { basis } = fixture();
    const dup: ScoringBasisT = {
      ...basis,
      units: [...basis.units, basis.units[0]],
    };
    const outcome = aggregateUnitResults(dup, [scored('u_choice', 4)]);
    expect(outcome).toMatchObject({
      kind: 'unresolved',
      reason: 'invalid_result',
      detail: "basis declares duplicate scoring_unit_id 'u_choice'",
    });
  });

  it('P1-A repro: blank_marked_zero with POSITIVE additive credit is rejected even when blank_scores_zero=true', () => {
    const { basis } = fixture(); // fixture.blank_scores_zero === true
    expect(basis.blank_scores_zero).toBe(true);
    const outcome = aggregateUnitResults(basis, [
      scored('u_choice', 2, { scored_because: 'blank_marked_zero' }), // 发布上限 4，但空白只能得 0
      scored('u_speed', 3),
      scored('u_reasoning', 3),
    ]);
    expect(outcome).toMatchObject({
      kind: 'unresolved',
      reason: 'invalid_result',
      detail: "unit 'u_choice' is blank_marked_zero but carries positive credit 2",
    });
    // 空白 + 0 分仍是合法路径（政策允许时）。
    const legit = aggregateUnitResults(basis, [
      scored('u_choice', 0, { scored_because: 'blank_marked_zero' }),
      scored('u_speed', 3),
      scored('u_reasoning', 3),
    ]);
    expect(legit).toMatchObject({ kind: 'points_total', points: 6 });
  });

  it('P1-A repro: blank_marked_zero cannot harvest positive credit through the holistic level mapping either', () => {
    const basis: ScoringBasisT = ScoringBasis.parse({
      units: [
        {
          scoring_unit_id: 'u_essay',
          slot_refs: ['essay'],
          criterion: {
            kind: 'holistic_level',
            levels: [
              { level_id: 'full', descriptor_md: '一等', rank: 2 },
              { level_id: 'zero', descriptor_md: '空白档', rank: 0 },
            ],
          },
          points: null,
          level_points: { full: 5, zero: 0 },
        },
      ],
      aggregation: { kind: 'sum' },
      blank_scores_zero: true,
    });
    const harvest = aggregateUnitResults(basis, [
      scored('u_essay', 0, {
        points_awarded: null,
        scored_because: 'blank_marked_zero',
        matched: { level_id: 'full', option_ids: [] },
      }),
    ]);
    expect(harvest).toMatchObject({
      kind: 'unresolved',
      reason: 'invalid_result',
      detail:
        "unit 'u_essay' is blank_marked_zero but its mapped level 'full' yields positive credit 5",
    });
    // 空白命中 0 分映射档位仍合法。
    const legit = aggregateUnitResults(basis, [
      scored('u_essay', 0, {
        points_awarded: null,
        scored_because: 'blank_marked_zero',
        matched: { level_id: 'zero', option_ids: [] },
      }),
    ]);
    expect(legit).toEqual({ kind: 'points_total', points: 0, policy: { kind: 'sum' } });
  });

  it('holistic level mapping: mapped level contributes exactly once; unmapped level yields no total (never fabricated)', () => {
    const basis: ScoringBasisT = ScoringBasis.parse({
      units: [
        {
          scoring_unit_id: 'u_essay',
          slot_refs: ['essay'],
          criterion: {
            kind: 'holistic_level',
            levels: [
              { level_id: 'l1', descriptor_md: '一等', rank: 2 },
              { level_id: 'l2', descriptor_md: '二等', rank: 1 },
              { level_id: 'l3', descriptor_md: '三等', rank: 0 },
            ],
          },
          points: null,
          level_points: { l1: 12, l2: 8 }, // l3 有意未映射
        },
      ],
      aggregation: { kind: 'sum' },
      blank_scores_zero: false,
    });
    const mapped = aggregateUnitResults(basis, [
      scored('u_essay', 0, { points_awarded: null, matched: { level_id: 'l2', option_ids: [] } }),
    ]);
    expect(mapped).toEqual({ kind: 'points_total', points: 8, policy: { kind: 'sum' } });

    const unmapped = aggregateUnitResults(basis, [
      scored('u_essay', 0, { points_awarded: null, matched: { level_id: 'l3', option_ids: [] } }),
    ]);
    expect(unmapped).toEqual({
      kind: 'unresolved',
      reason: 'no_mapping',
      detail: "unit 'u_essay' hit unmapped level 'l3'",
    });

    const noLevel = aggregateUnitResults(basis, [scored('u_essay', 0, { points_awarded: null })]);
    expect(noLevel).toMatchObject({ kind: 'unresolved', reason: 'no_mapping' });
  });

  it('composite additive + holistic units sum once each (objective points + essay level in one question)', () => {
    const basis: ScoringBasisT = ScoringBasis.parse({
      units: [
        {
          scoring_unit_id: 'u_mc',
          slot_refs: ['mc'],
          criterion: { kind: 'option_set_key', accepted_option_ids: ['o1'] },
          points: 6,
        },
        {
          scoring_unit_id: 'u_essay',
          slot_refs: ['essay'],
          criterion: {
            kind: 'holistic_level',
            levels: [
              { level_id: 'l1', descriptor_md: '一等', rank: 1 },
              { level_id: 'l2', descriptor_md: '二等', rank: 0 },
            ],
          },
          points: null,
          level_points: { l1: 8, l2: 5 },
        },
      ],
      aggregation: { kind: 'sum' },
      blank_scores_zero: false,
    });
    expect(
      aggregateUnitResults(basis, [
        scored('u_mc', 6),
        scored('u_essay', 0, { points_awarded: null, matched: { level_id: 'l1', option_ids: [] } }),
      ]),
    ).toEqual({ kind: 'points_total', points: 14, policy: { kind: 'sum' } });
  });

  it('YUK-1096 P1-3: holistic unit reporting its own points_awarded is invalid_result — even 0 or a lucky value', () => {
    const basis: ScoringBasisT = ScoringBasis.parse({
      units: [
        {
          scoring_unit_id: 'u_essay',
          slot_refs: ['essay'],
          criterion: {
            kind: 'holistic_level',
            levels: [
              { level_id: 'full', descriptor_md: '一等', rank: 2 },
              { level_id: 'zero', descriptor_md: '空白档', rank: 0 },
            ],
          },
          points: null,
          level_points: { full: 5, zero: 0 },
        },
      ],
      aggregation: { kind: 'sum' },
      blank_scores_zero: true,
    });
    // 999：执行器自造分数 —— level 映射是唯一权威，绝不泄入总分。
    const rogue = aggregateUnitResults(basis, [
      scored('u_essay', 999, { matched: { level_id: 'full', option_ids: [] } }),
    ]);
    expect(rogue.kind).toBe('unresolved');
    if (rogue.kind === 'unresolved') {
      expect(rogue.reason).toBe('invalid_result');
      expect(rogue.detail).toContain("holistic unit 'u_essay' carries points_awarded=999");
    }
    // 即使报 0 / 恰好等于映射分也是矛盾输入：holistic 纪律是 points_awarded 恒 null。
    const zero = aggregateUnitResults(basis, [
      scored('u_essay', 0, { matched: { level_id: 'zero', option_ids: [] } }),
    ]);
    expect(zero).toMatchObject({ kind: 'unresolved', reason: 'invalid_result' });
    const coincidental = aggregateUnitResults(basis, [
      scored('u_essay', 5, { matched: { level_id: 'full', option_ids: [] } }),
    ]);
    expect(coincidental).toMatchObject({ kind: 'unresolved', reason: 'invalid_result' });
  });
});

// ====================================================================
// ADR-0074 D3a — 配对（matching）与断句（sentence_breaks）确定性判分
// + 公私边界（键永不入公开 DTO）的不变量测试（fast include）。
// ====================================================================

function matchingFixture(options?: {
  rule?: Extract<ScoringUnitCriterionT, { kind: 'matching_pairs_key' }>['rule'];
  points?: number;
}): PublishedQuestionRevisionT {
  const revision: PublishedQuestionRevisionT = PublishedQuestionRevision.parse({
    revision_id: 'rev_match_1',
    group_id: 'grp_match',
    revision_ordinal: 1,
    integrity_digest: 'sha256:match',
    structure: {
      group_id: 'grp_match',
      materials: [],
      parts: [{ part_id: 'p1', prompt_md: '把作家与作品配对。', material_ids: [] }],
    },
    response_spec: {
      slots: [
        {
          slot_id: 'm1',
          part_id: 'p1',
          kind: 'matching',
          // 左右刻意不按声明顺序对应 —— 判分只认稳定 id，不认位置。
          left_items: [
            { item_id: 'i1', label: 'A', text: '鲁迅' },
            { item_id: 'i2', label: 'B', text: '沈从文' },
            { item_id: 'i3', label: 'C', text: '老舍' },
          ],
          right_options: [
            { option_id: 'r1', label: '1', text: '《边城》' },
            { option_id: 'r2', label: '2', text: '《呐喊》' },
            { option_id: 'r3', label: '3', text: '《茶馆》' },
            { option_id: 'r4', label: '4', text: '《围城》（干扰项）' },
          ],
          allow_left_unmatched: false,
          pairing: 'one_to_one',
          has_distractors: true,
        },
      ],
    },
    scoring_basis: {
      units: [
        {
          scoring_unit_id: 'u_match',
          slot_refs: ['m1'],
          criterion: {
            kind: 'matching_pairs_key',
            accepted_pairs: [
              { item_id: 'i1', option_id: 'r2' },
              { item_id: 'i2', option_id: 'r1' },
              { item_id: 'i3', option_id: 'r3' },
            ],
            ...(options?.rule ? { rule: options.rule } : {}),
          },
          points: options?.points ?? 6,
        },
      ],
      aggregation: { kind: 'sum' },
      blank_scores_zero: false,
    },
    execution_plan: {
      plan_version: 1,
      assignments: [
        {
          scoring_unit_ids: ['u_match'],
          executor: { kind: 'deterministic', comparator: 'exact_matching_pairs' },
        },
      ],
      escalation: { on_unadmitted_model: 'withhold', on_low_confidence: 'human_review' },
    },
    published_at: '2026-10-11T12:00:00.000Z',
    supersedes_revision_id: null,
  });
  return revision;
}

function breaksFixture(options?: {
  text?: string;
  accepted?: number[];
  rule?: Extract<ScoringUnitCriterionT, { kind: 'position_set_key' }>['rule'];
}): PublishedQuestionRevisionT {
  const text = options?.text ?? '学而时习之不亦说乎';
  const accepted = options?.accepted ?? [2, 5, 8];
  return PublishedQuestionRevision.parse({
    revision_id: 'rev_break_1',
    group_id: 'grp_break',
    revision_ordinal: 1,
    integrity_digest: 'sha256:break',
    structure: {
      group_id: 'grp_break',
      materials: [],
      parts: [{ part_id: 'p1', prompt_md: '用斜线（/）断句。', material_ids: [] }],
    },
    response_spec: {
      slots: [{ slot_id: 's1', part_id: 'p1', kind: 'sentence_breaks', text }],
    },
    scoring_basis: {
      units: [
        {
          scoring_unit_id: 'u_break',
          slot_refs: ['s1'],
          criterion: {
            kind: 'position_set_key',
            accepted_positions: accepted,
            ...(options?.rule ? { rule: options.rule } : {}),
          },
          points: 3,
        },
      ],
      aggregation: { kind: 'sum' },
      blank_scores_zero: false,
    },
    execution_plan: {
      plan_version: 1,
      assignments: [
        {
          scoring_unit_ids: ['u_break'],
          executor: { kind: 'deterministic', comparator: 'position_set_rule' },
        },
      ],
      escalation: { on_unadmitted_model: 'withhold', on_low_confidence: 'human_review' },
    },
    published_at: '2026-10-11T12:00:00.000Z',
    supersedes_revision_id: null,
  });
}

function submissionFor(
  revision: PublishedQuestionRevisionT,
  entries: SubmissionRecordT['response_set']['entries'],
): SubmissionRecordT {
  return {
    submission_id: 'sub_1',
    issuance_id: 'iss_1',
    revision_id: revision.revision_id,
    evaluation_group_id: 'eg_1',
    response_set: { entries },
    group_evidence: [],
    idempotency_key: 'idem-1',
    submitted_at: '2026-10-11T12:05:00.000Z',
  };
}

async function evaluate(
  revision: PublishedQuestionRevisionT,
  entries: SubmissionRecordT['response_set']['entries'],
) {
  return evaluateSubmissionCore({
    evaluation_id: 'ev_1',
    submission: submissionFor(revision, entries),
    revision,
    attempt: 1,
  });
}

describe('ADR-0074 D3a — matching 配对确定性判分', () => {
  // @invariant grading: printed pair/break rules determine points, including the overmark zero rule.
  // @fails-if a correct pair/break gets invented weight or overmarking earns points.
  it('printed rules award exact pair/break points and zero for excess breaks', async () => {
    const rule = { kind: 'per_correct_pair', points_per_pair: 2 } as const;
    const partial = await evaluate(matchingFixture({ rule }), [
      {
        slot_id: 'm1',
        kind: 'matching',
        pairs: [
          { item_id: 'i1', option_id: 'r2' },
          { item_id: 'i2', option_id: 'r1' },
          { item_id: 'i3', option_id: 'r4' },
        ],
      },
    ]);
    expect(partial.record.unit_results[0]).toMatchObject({ status: 'scored', points_awarded: 4 });

    const breaksRule = { kind: 'per_correct_break', points_per_break: 1, max_breaks: 3 } as const;
    const twoThirds = await evaluate(breaksFixture({ rule: breaksRule }), [
      { slot_id: 's1', kind: 'sentence_breaks', positions: [2, 6, 8] },
    ]);
    expect(twoThirds.record.unit_results[0]).toMatchObject({
      status: 'scored',
      points_awarded: 2,
    });
    const overmarked = await evaluate(breaksFixture({ rule: breaksRule }), [
      { slot_id: 's1', kind: 'sentence_breaks', positions: [2, 5, 8, 7] },
    ]);
    expect(overmarked.record.unit_results[0]).toMatchObject({
      status: 'scored',
      points_awarded: 0,
      feedback_md: 'rule_max_breaks_exceeded',
    });
  });

  // @invariant grading: no-rule sentence breaks retain typed counts and no fabricated score.
  // @fails-if non-exact position sets become pending prose, zero points, or a fraction.
  it('no printed rule: sentence-break partial stays scored with typed 2/3 and unknown points', async () => {
    const output = await evaluate(breaksFixture(), [
      { slot_id: 's1', kind: 'sentence_breaks', positions: [2, 6, 8] },
    ]);
    expect(output.record.status).toBe('completed');
    expect(output.record.unit_results[0]).toMatchObject({
      status: 'scored',
      points_awarded: null,
      partial_unknown_points: { correct_count: 2, total_count: 3 },
    });
    expect(output.record.aggregate).toMatchObject({
      kind: 'partial_unknown_points',
      known_points: 0,
      partial_units: [{ scoring_unit_id: 'u_break', correct_count: 2, total_count: 3 }],
    });
  });

  // @invariant grading: out-of-contract matching IDs/cardinality and break gaps are rejected before grading.
  // @fails-if foreign IDs, repeated one-to-one options, or invalid gaps receive a grade.
  it('foreign matching IDs, repeated one-to-one options and invalid break gaps fail closed', async () => {
    const revision = matchingFixture();
    await expect(
      evaluate(revision, [
        {
          slot_id: 'm1',
          kind: 'matching',
          pairs: [{ item_id: 'i1', option_id: 'r999' }],
        },
      ]),
    ).rejects.toMatchObject({ code: 'invalid_response_set' });

    await expect(
      evaluate(revision, [
        {
          slot_id: 'm1',
          kind: 'matching',
          pairs: [
            { item_id: 'i1', option_id: 'r2' },
            { item_id: 'i2', option_id: 'r2' },
          ],
        },
      ]),
    ).rejects.toMatchObject({ code: 'invalid_response_set' });

    // 断句位置：文首/文末/越界/重复 —— 同一 fail-closed 不变量的独立验证面。
    const breaks = breaksFixture(); // 9 字明文，有效内部字缝 1..8
    await expect(
      evaluate(breaks, [{ slot_id: 's1', kind: 'sentence_breaks', positions: [9] }]),
    ).rejects.toMatchObject({ code: 'invalid_response_set' });
    await expect(
      evaluate(breaks, [{ slot_id: 's1', kind: 'sentence_breaks', positions: [2, 2] }]),
    ).rejects.toMatchObject({ code: 'invalid_response_set' });
  });

  // @invariant grading: printed attainable totals must match published maximums.
  // @fails-if exact responses bypass contradictory rule weights or valid decimal weights are rejected.
  it('P1-2: printed rule attainable max must equal published points — contradictory rules are rejected at canonical scoring validation, even for exact answers', async () => {
    // 3 对 × 每对 4 分 = 12 ≠ 发布 6 分。
    await expect(
      evaluate(matchingFixture({ rule: { kind: 'per_correct_pair', points_per_pair: 4 } }), [
        {
          slot_id: 'm1',
          kind: 'matching',
          pairs: [
            { item_id: 'i1', option_id: 'r2' },
            { item_id: 'i2', option_id: 'r1' },
            { item_id: 'i3', option_id: 'r3' },
          ],
        },
      ]),
    ).rejects.toMatchObject({ code: 'invalid_scoring_basis' });
    // 3 断 × 每处 2 分 = 6 ≠ 发布 3 分。
    await expect(
      evaluate(
        breaksFixture({
          rule: { kind: 'per_correct_break', points_per_break: 2, max_breaks: 3 },
        }),
        [{ slot_id: 's1', kind: 'sentence_breaks', positions: [2, 5, 8] }],
      ),
    ).rejects.toMatchObject({ code: 'invalid_scoring_basis' });
    // 同一不变量的反面：合法十进制权重（1.5×3=4.5）不得被误拒，且照常精确判分。
    const decimal = await evaluate(
      matchingFixture({
        rule: { kind: 'per_correct_pair', points_per_pair: 1.5 },
        points: 4.5,
      }),
      [
        {
          slot_id: 'm1',
          kind: 'matching',
          pairs: [
            { item_id: 'i1', option_id: 'r2' },
            { item_id: 'i2', option_id: 'r1' },
            { item_id: 'i3', option_id: 'r4' },
          ],
        },
      ],
    );
    expect(decimal.record.unit_results[0]).toMatchObject({
      status: 'scored',
      points_awarded: 3, // 2 × 1.5
    });
    expect(decimal.record.aggregate).toMatchObject({ kind: 'points_total', points: 3 });
  });
});

describe('ADR-0074 D3a — sentence_breaks 断句确定性判分', () => {
  // @invariant grading: sentence gaps use frozen Unicode code points, including surrogate pairs.
  // @fails-if UTF-16 offsets admit the terminal gap or misgrade the reference position set.
  it('positions count Unicode code points (surrogate pair = one character); reference set scores full credit', async () => {
    const text = '甲乙𝄞丙丁';
    // 字缝 3 = 𝄞 与丙 之间（code point 计）；UTF-16 计数会把它错位成 3 与 4 之间。
    const withRule = breaksFixture({
      text,
      accepted: [2, 4],
      rule: { kind: 'per_correct_break', points_per_break: 1.5, max_breaks: 2 },
    });
    const output = await evaluate(withRule, [
      { slot_id: 's1', kind: 'sentence_breaks', positions: [4, 2] },
    ]);
    expect(output.record.unit_results[0]).toMatchObject({
      status: 'scored',
      points_awarded: 3,
    });
    await expect(
      evaluate(withRule, [{ slot_id: 's1', kind: 'sentence_breaks', positions: [5] }]),
    ).rejects.toMatchObject({ code: 'invalid_response_set' });
  });
});

describe('ADR-0074 D3a — 键永不入公开 DTO（公私边界）', () => {
  // @invariant security: public issuance includes frozen text without leaking private answer keys.
  // @fails-if matching/position criteria appear in public DTOs or injected private fields parse.
  it('projectPracticeIssuance carries the frozen text but no criterion/key material; strict schema rejects injected private fields', () => {
    const matching = matchingFixture();
    const revision: PublishedQuestionRevisionT = PublishedQuestionRevision.parse({
      ...matching,
      response_spec: {
        slots: [
          ...matching.response_spec.slots,
          {
            slot_id: 's1',
            part_id: 'p1',
            kind: 'sentence_breaks',
            text: '学而时习之不亦说乎',
          },
        ],
      },
      scoring_basis: {
        units: [
          ...matching.scoring_basis.units,
          {
            scoring_unit_id: 'u_break',
            slot_refs: ['s1'],
            criterion: {
              kind: 'position_set_key',
              accepted_positions: [2, 5, 8],
              rule: { kind: 'per_correct_break', points_per_break: 1, max_breaks: 3 },
            },
            points: 3,
          },
        ],
        aggregation: { kind: 'sum' },
        blank_scores_zero: false,
      },
      execution_plan: {
        plan_version: 1,
        assignments: [
          {
            scoring_unit_ids: ['u_match'],
            executor: { kind: 'deterministic', comparator: 'exact_matching_pairs' },
          },
          {
            scoring_unit_ids: ['u_break'],
            executor: { kind: 'deterministic', comparator: 'position_set_rule' },
          },
        ],
        escalation: { on_unadmitted_model: 'withhold', on_low_confidence: 'human_review' },
      },
    });
    const issuance = AssessmentIssuance.parse({
      issuance_id: 'iss_1',
      binding: deriveIssuanceBinding(revision),
      issued_at: '2026-10-11T12:00:00.000Z',
      claim: { policy: 'one_time', status: 'unclaimed', claimed_by_ref: null },
    });
    const dto = projectPracticeIssuance(revision, issuance);
    // 公开面有作答契约与冻结明文……
    const serialized = JSON.stringify(dto);
    // ……但没有任何键材料或题级规则（判据只在私有 scoring_basis 里）。
    expect(serialized).not.toContain('accepted_positions');
    expect(serialized).not.toContain('accepted_pairs');
    expect(serialized).not.toContain('points_per_break');
    expect(serialized).not.toContain('points_per_pair');
    expect(serialized).not.toContain('scoring_basis');
    // strictObject：向公开 DTO 注入私有字段直接 parse 失败 —— 边界是 schema 契约。
    const injected = PracticeIssuanceDto.safeParse({
      ...dto,
      scoring_basis: revision.scoring_basis,
    });
    expect(injected.success).toBe(false);
  });
});
