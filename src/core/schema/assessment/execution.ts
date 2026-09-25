import { z } from 'zod';

import type { ScoringBasisT, ScoringUnitCriterionT } from './scoring';

// ====================================================================
// YUK-1046 — 五层模型 · 第四层：执行计划（grounding §4.3、§5.3）
// ====================================================================
//
// 运行时【发布 plan】是评分语义权威：哪个执行器判哪些 scoring unit。
// profile 配置只是未来规划的默认值来源，不得静默覆盖已发题 plan。
// 服务可因模态/故障/低置信【升级执行器】（escalation），但绝不修改给分规则
// —— 给分规则只存在于 ScoringBasis，升级只换执行器。
//
// 执行器纪律（§4.1/§4.2/§5.3）：
//   - deterministic：保留确定性比较能力（exact V2 的集合/文本比较、
//     mathjs 数值/单位检查），固定梯度数值政策降级为历史，不做新题默认；
//   - model_executor：仅当该能力切片按 D17 准入后才可用于发题（admitted_slice
//     引用准入证据）；“声明了但实际没有 runner”的假能力不保留（fail-closed）；
//   - human_review：显式人工 / D9 手动路径（带 provenance，仅手动学习效应）。

/**
 * 确定性比较器 id（保留的确定性能力子集；新历史政策不当默认）。
 * P1-8：每个比较器只与一种判据相容（见 COMPARATOR_CRITERION），
 * 不相容组合在 validateExecutionPlan 拦截。
 */
export const DeterministicComparatorId = z.enum([
  'exact_option_set',
  'exact_text',
  'numeric_tolerance',
  'exact_matching_pairs',
]);
export type DeterministicComparatorIdT = z.infer<typeof DeterministicComparatorId>;

/** 比较器↔判据相容表：确定性执行器只能判对应种类的判据。 */
export const COMPARATOR_CRITERION: Readonly<
  Record<DeterministicComparatorIdT, ScoringUnitCriterionT['kind']>
> = {
  exact_option_set: 'option_set_key',
  exact_text: 'text_key',
  numeric_tolerance: 'numeric_key',
  exact_matching_pairs: 'matching_pairs_key',
};

export const DeterministicExecutor = z.object({
  kind: z.literal('deterministic'),
  comparator: DeterministicComparatorId,
});
export type DeterministicExecutorT = z.infer<typeof DeterministicExecutor>;

/** 模型执行器：绑定已准入能力切片（D17）与预算上限；未准入 → 不得发题。 */
export const ModelExecutor = z.object({
  kind: z.literal('model_executor'),
  /** 注册的判分 task kind（typed task，非通用 chat 代理）。 */
  task_kind: z.string().min(1),
  /** D17 准入的能力切片；null = 未准入（只能 withhold，不得执行）。 */
  admitted_slice_id: z.string().min(1).nullable(),
  max_cost_usd_micros: z.number().int().min(0).optional(),
});
export type ModelExecutorT = z.infer<typeof ModelExecutor>;

/** 人工复核 / D9 显式手动（provenance 由判分记录承载）。 */
export const HumanReviewExecutor = z.object({
  kind: z.literal('human_review'),
});
export type HumanReviewExecutorT = z.infer<typeof HumanReviewExecutor>;

export const ExecutorDescriptor = z.discriminatedUnion('kind', [
  DeterministicExecutor,
  ModelExecutor,
  HumanReviewExecutor,
]);
export type ExecutorDescriptorT = z.infer<typeof ExecutorDescriptor>;

/** 一个执行器负责一组 scoring unit（每 unit 恰好被覆盖一次）。 */
export const ExecutorAssignment = z.object({
  scoring_unit_ids: z.array(z.string().min(1)).min(1),
  executor: ExecutorDescriptor,
});
export type ExecutorAssignmentT = z.infer<typeof ExecutorAssignment>;

/** 升级策略：只换执行器，不改给分规则。 */
export const EscalationPolicy = z.object({
  on_unadmitted_model: z.enum(['human_review', 'withhold']),
  on_low_confidence: z.enum(['human_review', 'accept']),
});
export type EscalationPolicyT = z.infer<typeof EscalationPolicy>;

export const ExecutionPlan = z.object({
  plan_version: z.number().int().min(1),
  assignments: z.array(ExecutorAssignment).min(1),
  escalation: EscalationPolicy,
  max_total_cost_usd_micros: z.number().int().min(0).optional(),
});
export type ExecutionPlanT = z.infer<typeof ExecutionPlan>;

export interface ExecutionPlanIssue {
  code:
    | 'unit_not_covered'
    | 'unit_covered_twice'
    | 'unknown_unit_assignment'
    | 'comparator_criterion_mismatch'
    | 'unadmitted_model_executor';
  detail: string;
}

/**
 * 纯校验：每个 scoring unit 恰好被一个 assignment 覆盖（不漏不重 —— 与
 * scoring unit“贡献恰好一次”配套）；assignment 只能引用声明过的 unit
 * （P1-8）；确定性比较器只能判相容判据（P1-8，见 COMPARATOR_CRITERION）；
 * model_executor 未携带准入切片时给出显式问题（发布侧据此 withhold，
 * 而不是悄悄执行）。
 */
export function validateExecutionPlan(
  plan: ExecutionPlanT,
  basis: ScoringBasisT,
): ExecutionPlanIssue[] {
  const issues: ExecutionPlanIssue[] = [];
  const declared = new Map(basis.units.map((unit) => [unit.scoring_unit_id, unit] as const));
  const covered = new Map<string, number>();
  for (const assignment of plan.assignments) {
    for (const unitId of assignment.scoring_unit_ids) {
      covered.set(unitId, (covered.get(unitId) ?? 0) + 1);
      const unit = declared.get(unitId);
      if (unit == null) {
        issues.push({
          code: 'unknown_unit_assignment',
          detail: `assignment references scoring unit '${unitId}' not declared in the basis`,
        });
        continue;
      }
      if (
        assignment.executor.kind === 'deterministic' &&
        unit.criterion.kind !== COMPARATOR_CRITERION[assignment.executor.comparator]
      ) {
        issues.push({
          code: 'comparator_criterion_mismatch',
          detail: `comparator '${assignment.executor.comparator}' cannot judge unit '${unitId}' of criterion '${unit.criterion.kind}'`,
        });
      }
    }
    if (
      assignment.executor.kind === 'model_executor' &&
      assignment.executor.admitted_slice_id === null
    ) {
      issues.push({
        code: 'unadmitted_model_executor',
        detail: 'model_executor assignment has admitted_slice_id=null (withhold or escalate)',
      });
    }
  }
  for (const unitId of declared.keys()) {
    const count = covered.get(unitId) ?? 0;
    if (count === 0) {
      issues.push({ code: 'unit_not_covered', detail: `scoring unit '${unitId}' has no executor` });
    } else if (count > 1) {
      issues.push({
        code: 'unit_covered_twice',
        detail: `scoring unit '${unitId}' assigned to ${count} executors`,
      });
    }
  }
  return issues;
}
