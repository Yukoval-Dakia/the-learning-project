// YUK-1046 — ScoringBasis 契约测试：scoring unit 是唯一计分权威，
// 贡献恰好一次、无 slot+criterion+dimension 重复累加（grounding §4.4、D13）。

import { describe, expect, it } from 'vitest';

import { type ScoredUnitResultT, aggregateUnitResults } from './judgment';
import { ResponseSpec, type ResponseSpecT } from './response';
import { ScoringBasis, type ScoringBasisT } from './scoring';
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
