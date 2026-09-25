import { z } from 'zod';

import { EvaluationGroupId, EvaluationId, IssuanceId, RevisionId, SubmissionId } from './ids';
import { PendingState } from './pending';
import { ResponseSet } from './response';
import type { ScoringBasisT } from './scoring';
import { AggregationPolicy } from './scoring';

// ====================================================================
// YUK-1046 — 五层模型 · 第五层：判分记录（grounding §4.3、§11、D5/D13）
// ====================================================================
//
// 身份纪律：submission/evaluation_group/evaluation/revision 对新 runtime 必填
// （min(1)，不可选）；历史未知用 HistoricalUnknownSubmission 显式表达。
// 一份 submission 可有多个 evaluation attempt（重试身份 ≠ 学习事实身份）；
// candidate/shadow 永不进入 latest-judge 显示通道 —— 生效与否只由
// effective head（ids.ts）表达。
//
// D5：已接收（含 202）的作答守恒/零丢失 —— ResponseSet 原样冻结于
// SubmissionRecord；rejudge/appeal 只重解读原证据（D8），不改写 submission。

// ---------- submission ----------

export const SubmissionRecord = z.object({
  submission_id: SubmissionId,
  issuance_id: IssuanceId,
  revision_id: RevisionId,
  evaluation_group_id: EvaluationGroupId,
  response_set: ResponseSet,
  /** 幂等键：同 key 不同答案/附件/revision ⇒ 冲突（不是覆盖）。 */
  idempotency_key: z.string().min(1),
  submitted_at: z.string().datetime(),
});
export type SubmissionRecordT = z.infer<typeof SubmissionRecord>;

/**
 * 迁移前历史记录缺冻结上下文的显式类型（§3.2/§13）：locator 非空，
 * revision/submission 身份未知就是未知 —— 不用可选字段让新请求逃避冻结，
 * 也不得用当前 revision 补造当时所见。
 */
export const HistoricalUnknownSubmission = z.object({
  record_kind: z.literal('historical_unknown'),
  source_kind: z.string().min(1),
  source_id: z.string().min(1),
  source_locator: z.string().min(1),
  note: z.string().default(''),
});
export type HistoricalUnknownSubmissionT = z.infer<typeof HistoricalUnknownSubmission>;

// ---------- evaluation group ----------

/**
 * 联合判分组：一次 settle 的单位。solo 单题 = 单 submission group；
 * paper/整页照证据 = 多 submission 联合组（跨小问证据只在组内共享）。
 */
export const EvaluationGroup = z.object({
  evaluation_group_id: EvaluationGroupId,
  submission_ids: z.array(SubmissionId).min(1),
});
export type EvaluationGroupT = z.infer<typeof EvaluationGroup>;

// ---------- unit 结果 ----------

/** 结果内证据引用：指向 slot / 附件证据 / 原文引语（模型只报告证据，不造证据）。 */
export const EvidenceCitation = z.object({
  slot_id: z.string().min(1).optional(),
  evidence_id: z.string().min(1).optional(),
  quote: z.string().optional(),
});
export type EvidenceCitationT = z.infer<typeof EvidenceCitation>;

/**
 * 单元已判分。scored_because 显式区分“作答判得”与“空白按声明 marking 计零”
 * （blank_marked_zero 只在 basis.blank_scores_zero=true 时合法 —— 由
 * settlement lane 校验；类型层先保证不是伪零分冒充）。
 *
 * points_awarded：加法单元必填；holistic 单元为 null —— 执行器只报告
 * matched.level_id，分数由发布侧 level_points 映射在聚合时解析
 * （模型不得在输出里自造等级分数）。
 */
export const ScoredUnitResult = z.object({
  status: z.literal('scored'),
  scoring_unit_id: z.string().min(1),
  points_awarded: z.number().min(0).nullable(),
  scored_because: z.enum(['response', 'blank_marked_zero']),
  matched: z
    .object({
      rule_id: z.string().min(1).optional(),
      level_id: z.string().min(1).optional(),
      option_ids: z.array(z.string().min(1)).default([]),
    })
    .optional(),
  feedback_md: z.string().optional(),
  evidence_citations: z.array(EvidenceCitation).default([]),
});
export type ScoredUnitResultT = z.infer<typeof ScoredUnitResult>;

/** 单元未决 —— PendingState 显式给出原因；绝无伪零分。 */
export const PendingUnitResult = z.object({
  status: z.literal('pending'),
  scoring_unit_id: z.string().min(1),
  pending: PendingState,
});
export type PendingUnitResultT = z.infer<typeof PendingUnitResult>;

export const ScoringUnitResult = z.discriminatedUnion('status', [
  ScoredUnitResult,
  PendingUnitResult,
]);
export type ScoringUnitResultT = z.infer<typeof ScoringUnitResult>;

// ---------- 聚合结果 ----------

/**
 * 聚合结果。unresolved 永远是显式分支：
 *   - pending_units：存在未决单元（先决条件不满足，不得出总分）；
 *   - no_mapping：整体等级命中未映射档位 —— 不凭空制造总分（points 为 null
 *     的 level 是合法呈现，但它不是“总分缺失”的错误，而是显式无总分）；
 *   - result_set_mismatch：结果集与 unit 集不一一对应（调用方bug，防御）。
 */
export const AggregateOutcome = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('points_total'),
    points: z.number().min(0),
    /** 判分时实际执行的聚合 policy 快照（可审计）。 */
    policy: AggregationPolicy,
  }),
  z.object({
    kind: z.literal('level'),
    level_id: z.string().min(1),
    /** null = 该档位未提供分数映射 —— 不制造总分。 */
    points: z.number().min(0).nullable(),
  }),
  z.object({
    kind: z.literal('unresolved'),
    reason: z.enum(['pending_units', 'no_mapping', 'result_set_mismatch']),
    detail: z.string().default(''),
  }),
]);
export type AggregateOutcomeT = z.infer<typeof AggregateOutcome>;

// ---------- evaluation record ----------

export const EvaluationRecord = z.object({
  evaluation_id: EvaluationId,
  evaluation_group_id: EvaluationGroupId,
  submission_id: SubmissionId,
  /** 第几次评估尝试（≥1）；重试身份 ≠ 学习事实身份。 */
  attempt: z.number().int().min(1),
  status: z.enum(['pending', 'completed']),
  unit_results: z.array(ScoringUnitResult).default([]),
  /** pending 期间为 null；completed 时为聚合结果（可为 unresolved 分支）。 */
  aggregate: AggregateOutcome.nullable(),
  /** 执行溯源：plan digest 与 run 引用（费用/重试真相在 task_run 侧）。 */
  plan_digest: z.string().min(1).nullable().optional(),
  run_refs: z.array(z.string().min(1)).default([]),
});
export type EvaluationRecordT = z.infer<typeof EvaluationRecord>;

// ---------- 确定性聚合原语 ----------

/**
 * 唯一聚合点：unit 结果 → 总分/等级，每个 unit 恰好计一次。
 *
 * 规则（§4.4 / D13 —— 总分只聚合一次）：
 *   - 结果集必须与 basis.units 一一对应（缺失或重复 ⇒ result_set_mismatch）；
 *   - 任一 pending ⇒ unresolved(pending_units)；
 *   - holistic 单元：取 matched.level_id 查发布侧 level_points；
 *     缺 level_id 或命中未映射档位 ⇒ unresolved(no_mapping) ——
 *     【不凭空制造总分】；加法单元结果缺 points ⇒ result_set_mismatch；
 *   - sum / weighted_sum / capped_sum / threshold_levels：加法路径，先按
 *     policy 聚合（weighted 只用已验证覆盖的 weights），thresholds 取
 *     满足 min_points 的最高档。
 */
export function aggregateUnitResults(
  basis: ScoringBasisT,
  unitResults: readonly ScoringUnitResultT[],
): AggregateOutcomeT {
  const unitById = new Map(basis.units.map((unit) => [unit.scoring_unit_id, unit] as const));
  const unitIds = basis.units.map((unit) => unit.scoring_unit_id);
  const resultById = new Map<string, ScoringUnitResultT>();
  for (const result of unitResults) {
    if (resultById.has(result.scoring_unit_id)) {
      return {
        kind: 'unresolved',
        reason: 'result_set_mismatch',
        detail: `duplicate result for unit '${result.scoring_unit_id}'`,
      };
    }
    resultById.set(result.scoring_unit_id, result);
  }
  for (const unitId of unitIds) {
    if (!resultById.has(unitId)) {
      return {
        kind: 'unresolved',
        reason: 'result_set_mismatch',
        detail: `missing result for unit '${unitId}'`,
      };
    }
  }

  const pendingIds = unitIds.filter((id) => resultById.get(id)?.status === 'pending');
  if (pendingIds.length > 0) {
    return {
      kind: 'unresolved',
      reason: 'pending_units',
      detail: `pending units: ${pendingIds.join(',')}`,
    };
  }

  const scored = (id: string): ScoredUnitResultT => resultById.get(id) as ScoredUnitResultT;

  type Contribution =
    | { kind: 'points'; points: number }
    | { kind: 'no_mapping'; detail: string }
    | { kind: 'mismatch'; detail: string };

  // 每单元解析恰好一次贡献：加法用结果分；holistic 用发布侧 level_points 映射。
  const contributionOf = (unitId: string): Contribution => {
    const unit = unitById.get(unitId);
    const result = scored(unitId);
    if (unit != null && unit.criterion.kind === 'holistic_level') {
      const levelId = result.matched?.level_id;
      if (levelId == null) {
        return { kind: 'no_mapping', detail: `unit '${unitId}' reports no matched level` };
      }
      const mapped = unit.level_points?.[levelId];
      if (mapped === undefined) {
        // 档位未映射 —— 不凭空制造总分。
        return {
          kind: 'no_mapping',
          detail: `unit '${unitId}' hit unmapped level '${levelId}'`,
        };
      }
      return { kind: 'points', points: mapped };
    }
    if (result.points_awarded === null) {
      return {
        kind: 'mismatch',
        detail: `additive unit '${unitId}' result carries null points_awarded`,
      };
    }
    return { kind: 'points', points: result.points_awarded };
  };

  const resolved: Array<{ unitId: string; points: number }> = [];
  for (const unitId of unitIds) {
    const contribution = contributionOf(unitId);
    if (contribution.kind !== 'points') {
      return {
        kind: 'unresolved',
        reason: contribution.kind === 'no_mapping' ? 'no_mapping' : 'result_set_mismatch',
        detail: contribution.detail,
      };
    }
    resolved.push({ unitId, points: contribution.points });
  }

  const weightOf = (unitId: string): number => {
    if (basis.aggregation.kind === 'weighted_sum') {
      // 覆盖性已由 validateScoringBasis 保证；防御缺 key 时按 0 计。
      return basis.aggregation.weights[unitId] ?? 0;
    }
    return 1;
  };

  let total = resolved.reduce((sum, entry) => sum + entry.points * weightOf(entry.unitId), 0);
  if (basis.aggregation.kind === 'capped_sum') {
    total = Math.min(total, basis.aggregation.cap);
  }
  if (basis.aggregation.kind === 'threshold_levels') {
    const eligible = basis.aggregation.thresholds
      .filter((threshold) => total >= threshold.min_points)
      .sort((a, b) => b.min_points - a.min_points);
    const top = eligible[0];
    if (top == null) {
      return {
        kind: 'unresolved',
        reason: 'no_mapping',
        detail: `aggregate ${total} below every declared threshold`,
      };
    }
    return { kind: 'level', level_id: top.level_id, points: total };
  }
  return { kind: 'points_total', points: total, policy: basis.aggregation };
}

// ---------- 幂等冲突判定（D5/§4.3） ----------

export type SubmissionIdempotencyOutcome =
  | { outcome: 'same_payload' }
  | { outcome: 'conflict'; reason: 'revision_changed' | 'response_changed' };

/**
 * 纯判定：同 idempotency_key 重复提交时，逐字相同的冻结输入幂等重放，
 * 不同答案/附件/revision ⇒ 冲突（不覆盖、不丢已接收作答）。
 */
export function resolveSubmissionIdempotency(
  existing: SubmissionRecordT,
  incoming: SubmissionRecordT,
): SubmissionIdempotencyOutcome {
  if (existing.idempotency_key !== incoming.idempotency_key) {
    throw new Error('resolveSubmissionIdempotency: idempotency keys differ');
  }
  if (existing.revision_id !== incoming.revision_id) {
    return { outcome: 'conflict', reason: 'revision_changed' };
  }
  const sameResponses =
    JSON.stringify(existing.response_set) === JSON.stringify(incoming.response_set);
  return sameResponses
    ? { outcome: 'same_payload' }
    : { outcome: 'conflict', reason: 'response_changed' };
}
