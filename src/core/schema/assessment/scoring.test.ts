// YUK-1046 — ScoringBasis 契约测试：scoring unit 是唯一计分权威，
// 贡献恰好一次、无 slot+criterion+dimension 重复累加（grounding §4.4、D13）。

import { describe, expect, it } from 'vitest';

import { type ScoredUnitResultT, aggregateUnitResults } from './judgment';
import { ResponseSpec, type ResponseSpecT } from './response';
import { ScoringBasis, type ScoringBasisT, validateScoringBasis } from './scoring';
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
      { slot_id: 'ans', kind: 'numeric', unit_hint: 'm/s' },
      { slot_id: 'essay', kind: 'open_response' },
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

describe('validateScoringBasis — 引用与身份纪律', () => {
  it('accepts the composite fixture (units reference their slots/materials explicitly)', () => {
    const { spec, structure, basis } = fixture();
    expect(validateScoringBasis(basis, spec, structure)).toEqual([]);
  });

  it('flags dangling slot/material/evidence refs and duplicate unit ids', () => {
    const { spec, structure } = fixture();
    const basis: ScoringBasisT = ScoringBasis.parse({
      units: [
        {
          scoring_unit_id: 'u1',
          slot_refs: ['ghost_slot'],
          material_refs: ['ghost_mat'],
          evidence_slot_refs: ['ans'], // 非 open_response 槽
          criterion: { kind: 'text_key', accepted_texts: ['42'] },
          points: 1,
        },
        {
          scoring_unit_id: 'u1',
          slot_refs: ['mc'],
          criterion: { kind: 'text_key', accepted_texts: ['42'] },
          points: 1,
        },
      ],
      aggregation: { kind: 'sum' },
      blank_scores_zero: false,
    });
    const codes = validateScoringBasis(basis, spec, structure).map((issue) => issue.code);
    expect(codes).toContain('duplicate_scoring_unit_id');
    expect(codes).toContain('unresolved_slot_ref');
    expect(codes).toContain('unresolved_material_ref');
    expect(codes).toContain('evidence_slot_not_open');
  });

  it('additive units require points; holistic units must leave points null and carry level_points', () => {
    const { spec, structure } = fixture();
    const additiveNull: ScoringBasisT = ScoringBasis.parse({
      units: [
        {
          scoring_unit_id: 'u',
          slot_refs: ['mc'],
          criterion: { kind: 'option_set_key', accepted_option_ids: ['o1'] },
          points: null,
        },
      ],
      aggregation: { kind: 'sum' },
      blank_scores_zero: false,
    });
    expect(
      validateScoringBasis(additiveNull, spec, structure).map((issue) => issue.code),
    ).toContain('points_required_for_additive_unit');

    const additiveWithLevelPoints: ScoringBasisT = ScoringBasis.parse({
      units: [
        {
          scoring_unit_id: 'u',
          slot_refs: ['mc'],
          criterion: { kind: 'option_set_key', accepted_option_ids: ['o1'] },
          points: 3,
          level_points: { l1: 3 }, // 加法单元禁止携带等级映射
        },
      ],
      aggregation: { kind: 'sum' },
      blank_scores_zero: false,
    });
    expect(
      validateScoringBasis(additiveWithLevelPoints, spec, structure).map((issue) => issue.code),
    ).toContain('level_points_forbidden_for_additive_unit');

    const holisticWithPoints: ScoringBasisT = ScoringBasis.parse({
      units: [
        {
          scoring_unit_id: 'u',
          slot_refs: ['essay'],
          criterion: {
            kind: 'holistic_level',
            levels: [
              { level_id: 'l1', descriptor_md: '一等：论证完整', rank: 2 },
              { level_id: 'l2', descriptor_md: '二等：论证基本完整', rank: 1 },
            ],
          },
          points: 10, // holistic 单元的 points 必须为 null
        },
      ],
      aggregation: { kind: 'sum' },
      blank_scores_zero: false,
    });
    const holisticIssues = validateScoringBasis(holisticWithPoints, spec, structure).map(
      (issue) => issue.code,
    );
    expect(holisticIssues).toContain('points_must_be_null_for_holistic_unit');
    // points 之外还缺显式 level_points 映射
    expect(holisticIssues).toContain('level_points_required_for_holistic_unit');

    const undeclaredLevel: ScoringBasisT = ScoringBasis.parse({
      units: [
        {
          scoring_unit_id: 'u',
          slot_refs: ['essay'],
          criterion: {
            kind: 'holistic_level',
            levels: [
              { level_id: 'l1', descriptor_md: '一等', rank: 2 },
              { level_id: 'l2', descriptor_md: '二等', rank: 1 },
            ],
          },
          points: null,
          level_points: { l9: 5 }, // 未声明档位
        },
      ],
      aggregation: { kind: 'sum' },
      blank_scores_zero: false,
    });
    expect(
      validateScoringBasis(undeclaredLevel, spec, structure).map((issue) => issue.code),
    ).toContain('level_points_level_not_declared');
  });

  it('weighted_sum must cover every unit exactly once (no unit double-weighted or dropped)', () => {
    const { spec, structure, basis } = fixture();
    const weightsMissingOne: ScoringBasisT = ScoringBasis.parse({
      ...basis,
      aggregation: { kind: 'weighted_sum', weights: { u_choice: 1, u_speed: 0.5 } },
    });
    expect(
      validateScoringBasis(weightsMissingOne, spec, structure).map((issue) => issue.code),
    ).toContain('weights_must_cover_units_exactly');

    const weightsWithExtra: ScoringBasisT = ScoringBasis.parse({
      ...basis,
      aggregation: {
        kind: 'weighted_sum',
        weights: { u_choice: 1, u_speed: 0.5, u_reasoning: 1, ghost: 2 },
      },
    });
    expect(
      validateScoringBasis(weightsWithExtra, spec, structure).map((issue) => issue.code),
    ).toContain('weights_must_cover_units_exactly');
  });

  it('a unit referencing nothing at all is rejected (no free-floating points)', () => {
    const { spec, structure } = fixture();
    const basis: ScoringBasisT = ScoringBasis.parse({
      units: [
        {
          scoring_unit_id: 'u_ghost',
          slot_refs: [],
          material_refs: [],
          evidence_slot_refs: [],
          criterion: { kind: 'text_key', accepted_texts: ['x'] },
          points: 5,
        },
      ],
      aggregation: { kind: 'sum' },
      blank_scores_zero: false,
    });
    expect(validateScoringBasis(basis, spec, structure).map((issue) => issue.code)).toContain(
      'no_unit_references_any_slot',
    );
  });
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
});
