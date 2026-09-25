// YUK-1046 — 执行计划契约测试：plan 是评分语义权威；每 unit 恰好一个执行器；
// 未准入模型执行器显式暴露（不悄悄执行）。

import { describe, expect, it } from 'vitest';

import { ExecutionPlan, type ExecutionPlanT, validateExecutionPlan } from './execution';
import { ScoringBasis, type ScoringBasisT } from './scoring';

function basis(): ScoringBasisT {
  return ScoringBasis.parse({
    units: [
      {
        scoring_unit_id: 'u_choice',
        slot_refs: ['mc'],
        criterion: { kind: 'option_set_key', accepted_option_ids: ['o1'] },
        points: 4,
      },
      {
        scoring_unit_id: 'u_num',
        slot_refs: ['num'],
        criterion: {
          kind: 'numeric_key',
          expected: 9.8,
          tolerance: { kind: 'absolute', value: 0.1 },
        },
        points: 3,
      },
      {
        scoring_unit_id: 'u_essay',
        slot_refs: ['essay'],
        criterion: {
          kind: 'rule_reference',
          rule_id: 'r1',
          statement_md: '按官方评分点给分……（长规则文本）',
          source: 'official',
        },
        points: 8,
      },
    ],
    aggregation: { kind: 'sum' },
    blank_scores_zero: false,
  });
}

function plan(assignments: ExecutionPlanT['assignments']): ExecutionPlanT {
  return ExecutionPlan.parse({
    plan_version: 1,
    assignments,
    escalation: { on_unadmitted_model: 'human_review', on_low_confidence: 'human_review' },
  });
}

describe('validateExecutionPlan — 恰好覆盖一次', () => {
  it('accepts deterministic + admitted-model + human split', () => {
    const result = validateExecutionPlan(
      plan([
        {
          scoring_unit_ids: ['u_choice', 'u_num'],
          executor: { kind: 'deterministic', comparator: 'exact_option_set' },
        },
        {
          scoring_unit_ids: ['u_essay'],
          executor: {
            kind: 'model_executor',
            task_kind: 'judge/rubric_v1',
            admitted_slice_id: 'slice_essay_zh_v3',
            max_cost_usd_micros: 40_000,
          },
        },
      ]),
      basis(),
    );
    expect(result).toEqual([]);
  });

  it('flags uncovered and double-covered units', () => {
    const issues = validateExecutionPlan(
      plan([
        {
          scoring_unit_ids: ['u_choice'],
          executor: { kind: 'deterministic', comparator: 'exact_option_set' },
        },
        {
          scoring_unit_ids: ['u_choice', 'u_essay'],
          executor: { kind: 'human_review' },
        },
      ]),
      basis(),
    );
    const codes = issues.map((issue) => issue.code);
    expect(codes).toContain('unit_not_covered'); // u_num 无人负责
    expect(codes).toContain('unit_covered_twice'); // u_choice 被两个执行器负责
  });

  it('flags unadmitted model executors (admitted_slice_id=null must be withheld, not run)', () => {
    const issues = validateExecutionPlan(
      plan([
        {
          scoring_unit_ids: ['u_choice', 'u_num'],
          executor: { kind: 'deterministic', comparator: 'exact_option_set' },
        },
        {
          scoring_unit_ids: ['u_essay'],
          executor: {
            kind: 'model_executor',
            task_kind: 'judge/rubric_v1',
            admitted_slice_id: null,
          },
        },
      ]),
      basis(),
    );
    expect(issues.map((issue) => issue.code)).toContain('unadmitted_model_executor');
  });

  it('escalation only swaps executors — scoring rules live in the basis, not the plan', () => {
    const parsed = ExecutionPlan.parse({
      plan_version: 2,
      assignments: [
        {
          scoring_unit_ids: ['u_essay'],
          executor: { kind: 'human_review' },
        },
      ],
      escalation: { on_unadmitted_model: 'withhold', on_low_confidence: 'accept' },
    });
    expect(JSON.stringify(parsed)).not.toContain('points');
    expect(JSON.stringify(parsed)).not.toContain('accepted_option_ids');
  });
});
