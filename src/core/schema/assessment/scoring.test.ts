// YUK-1046 — ScoringBasis 契约测试：scoring unit 是唯一计分权威，
// 贡献恰好一次、无 slot+criterion+dimension 重复累加（grounding §4.4、D13）。

import { describe, expect, it } from 'vitest';

import { PracticeIssuanceDto, projectPracticeIssuance } from './dto';
import { type ScoredUnitResultT, aggregateUnitResults } from './judgment';
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

// @invariant grading: a duplicated or missing unit result fails closed as result_set_mismatch
// @fails-if extra or missing results are silently averaged into the published total
it('duplicate or missing unit results are result_set_mismatch — never silently averaged', () => {
  const { basis } = fixture();
  expect(aggregateUnitResults(basis, [scored('u_choice', 4), scored('u_choice', 2)]).kind).toBe(
    'unresolved',
  );
  expect(aggregateUnitResults(basis, [scored('u_choice', 4)]).kind).toBe('unresolved');
});

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
