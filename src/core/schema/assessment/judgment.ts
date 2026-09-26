import { z } from 'zod';

// YUK-1052 — 幂等载荷比对必须规范化：持久层存 jsonb，PostgreSQL 重排对象键序
// （按长度+字典序），原样 JSON.stringify(existing) 永远 ≠ 同内容 incoming →
// 每次重试都被误判成 conflict。canonical 排序键序后再比对才是“逐字相同”。
import { stableStringify } from '../../migration/canonical';
import { EvaluationGroupId, EvaluationId, IssuanceId, RevisionId, SubmissionId } from './ids';
import { EvidenceAttachment } from './materials';
import { PendingState } from './pending';
import { ResponseSet } from './response';
import type { ScoringBasisT, ScoringUnitT } from './scoring';
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

// ---------- group 级证据（P1-6：整页照等 whole-group 证据的显式载体） ----------

/**
 * 声明式关联目标：默认附到当前 evaluation group（all_units），
 * 或显式收窄到一组 scoring unit（§7.3 “允许调整关联子集”）。
 * 不从数组顺序推断归属，也不把共享证据复制进无关槽位。
 */
export const GroupEvidenceTarget = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('all_units') }),
  z.object({
    scope: z.literal('units'),
    scoring_unit_ids: z.array(z.string().min(1)).min(1),
  }),
]);
export type GroupEvidenceTargetT = z.infer<typeof GroupEvidenceTarget>;

/** 提交时冻结的 group 级原始证据（如整页解题照）；目标子集随后可显式调整。 */
export const GroupEvidence = z.object({
  evidence: EvidenceAttachment,
  target: GroupEvidenceTarget,
});
export type GroupEvidenceT = z.infer<typeof GroupEvidence>;

// ---------- submission ----------

export const SubmissionRecord = z.object({
  submission_id: SubmissionId,
  issuance_id: IssuanceId,
  revision_id: RevisionId,
  evaluation_group_id: EvaluationGroupId,
  response_set: ResponseSet,
  /** group 级原始证据（P1-6；requires_group_evidence 的单元从这里取证据）。 */
  group_evidence: z.array(GroupEvidence).default([]),
  /** 幂等键：同 key 不同答案/附件/revision/occurrence ⇒ 冲突（不是覆盖）。 */
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
 *   - no_mapping：整体等级命中未映射档位（或无档位）—— 不凭空制造总分；
 *   - result_set_mismatch：结果集与 unit 集不一一对应（多余/缺失/重复）；
 *   - invalid_result：值级违规（超出发布上限、政策禁止的空白计零、加法单元
 *     缺分、basis 自身不变量破坏、weighted 缺权重）—— 一律 fail-closed。
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
    reason: z.enum(['pending_units', 'no_mapping', 'result_set_mismatch', 'invalid_result']),
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
  /**
   * D9/D15/D16 判分来源 provenance：显式手动/自评必须标注（仅手动学习效应，
   * 绝不推断 AI 正确性）；assisted 保留分数但排除 hard mastery/calibration。
   * 缺省 = automatic。
   */
  provenance: z
    .object({
      source: z.enum(['automatic', 'manual', 'self_report']),
      assisted: z.boolean().default(false),
    })
    .optional(),
});
export type EvaluationRecordT = z.infer<typeof EvaluationRecord>;

// ---------- 确定性聚合原语 ----------

/**
 * 唯一聚合点：unit 结果 → 总分/等级，每个 unit 恰好计一次。fail-closed：
 *
 * 规则（§4.4 / D13 —— 总分只聚合一次；P1-1 复审加严）：
 *   - basis 自身防御：重复 unit id ⇒ invalid_result（不得双计）；
 *   - 结果集必须与 basis.units 【恰好相等】（多余 ⇒ mismatch —— 多余结果
 *     不得被忽略，也不得混入总分）；
 *   - 任一 pending ⇒ unresolved(pending_units)（多余 pending 结果同样先被
 *     集合相等性拦下）；
 *   - 加法单元结果不得超出发布上限 points（超出 ⇒ invalid_result ——
 *     执行器不能自己发明分数）；
 *   - blank_scores_zero=false 时 blank_marked_zero 结果 ⇒ invalid_result
 *     （空白计零必须政策明确）；
 *   - holistic 单元：取 matched.level_id 查发布侧 level_points；缺 level_id
 *     或命中未映射档位 ⇒ no_mapping —— 不凭空制造总分；
 *   - weighted 缺权重 ⇒ invalid_result（绝不雷默当 0）；
 *   - sum / weighted_sum / capped_sum / threshold_levels：加法路径；
 *     thresholds 取满足 min_points 的最高档。
 */
export function aggregateUnitResults(
  basis: ScoringBasisT,
  unitResults: readonly ScoringUnitResultT[],
): AggregateOutcomeT {
  // basis 防御：重复 unit id 会让下方 Map 静默合并双计（P1-1）。
  const unitById = new Map<string, ScoringUnitT>();
  for (const unit of basis.units) {
    if (unitById.has(unit.scoring_unit_id)) {
      return {
        kind: 'unresolved',
        reason: 'invalid_result',
        detail: `basis declares duplicate scoring_unit_id '${unit.scoring_unit_id}'`,
      };
    }
    unitById.set(unit.scoring_unit_id, unit);
  }
  const unitIds = [...unitById.keys()];

  // 集合相等：多余结果不忽略、不混入（未知 unit 的 pending 也不许静默丢弃）。
  const resultById = new Map<string, ScoringUnitResultT>();
  for (const result of unitResults) {
    if (resultById.has(result.scoring_unit_id)) {
      return {
        kind: 'unresolved',
        reason: 'result_set_mismatch',
        detail: `duplicate result for unit '${result.scoring_unit_id}'`,
      };
    }
    if (!unitById.has(result.scoring_unit_id)) {
      return {
        kind: 'unresolved',
        reason: 'result_set_mismatch',
        detail: `result for undeclared unit '${result.scoring_unit_id}'`,
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
    | { kind: 'invalid'; detail: string };

  // 每单元解析恰好一次贡献：加法用结果分（受发布上限约束）；
  // holistic 用发布侧 level_points 映射；空白计零受 basis 政策约束，
  // 且【绝不允许解析为正分】（P1-A：加法正分与 holistic 正映射都算矛盾结果）。
  const contributionOf = (unitId: string): Contribution => {
    const unit = unitById.get(unitId) as ScoringUnitT;
    const result = scored(unitId);
    if (result.scored_because === 'blank_marked_zero' && !basis.blank_scores_zero) {
      return {
        kind: 'invalid',
        detail: `unit '${unitId}' scored blank as zero but basis.blank_scores_zero=false`,
      };
    }
    if (unit.criterion.kind === 'holistic_level') {
      const levelId = result.matched?.level_id;
      if (levelId == null) {
        return { kind: 'no_mapping', detail: `unit '${unitId}' reports no matched level` };
      }
      const mapped = unit.level_points?.[levelId];
      if (mapped === undefined) {
        // 档位未映射（含纯档位 rubric）—— 不凭空制造总分。
        return {
          kind: 'no_mapping',
          detail: `unit '${unitId}' hit unmapped level '${levelId}'`,
        };
      }
      if (result.scored_because === 'blank_marked_zero' && mapped > 0) {
        // P1-A：空白判零的结果不得经 holistic 映射获得正分。
        return {
          kind: 'invalid',
          detail: `unit '${unitId}' is blank_marked_zero but its mapped level '${levelId}' yields positive credit ${mapped}`,
        };
      }
      return { kind: 'points', points: mapped };
    }
    if (result.points_awarded === null) {
      return {
        kind: 'invalid',
        detail: `additive unit '${unitId}' result carries null points_awarded`,
      };
    }
    if (unit.points !== null && result.points_awarded > unit.points) {
      return {
        kind: 'invalid',
        detail: `unit '${unitId}' awarded ${result.points_awarded} above published max ${unit.points}`,
      };
    }
    if (result.scored_because === 'blank_marked_zero' && result.points_awarded > 0) {
      // P1-A：空白判零却携带正分是矛盾结果 —— 拒绝，不静默改写为 0。
      return {
        kind: 'invalid',
        detail: `unit '${unitId}' is blank_marked_zero but carries positive credit ${result.points_awarded}`,
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
        reason: contribution.kind === 'no_mapping' ? 'no_mapping' : 'invalid_result',
        detail: contribution.detail,
      };
    }
    resolved.push({ unitId, points: contribution.points });
  }

  // weighted 缺权重 ⇒ fail-closed（不得雷默当 0，P1-1）。
  if (basis.aggregation.kind === 'weighted_sum') {
    for (const unitId of unitIds) {
      if (!(unitId in basis.aggregation.weights)) {
        return {
          kind: 'unresolved',
          reason: 'invalid_result',
          detail: `weighted_sum is missing a weight for unit '${unitId}'`,
        };
      }
    }
  }
  const weightOf = (unitId: string): number => {
    if (basis.aggregation.kind === 'weighted_sum') {
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

// ---------- 幂等冲突判定（D5/§4.3；P1-7：occurrence 身份参与冲突判定） ----------

export type SubmissionIdempotencyOutcome =
  | { outcome: 'same_payload' }
  | {
      outcome: 'conflict';
      reason:
        | 'revision_changed'
        | 'issuance_mismatch'
        | 'evaluation_group_mismatch'
        | 'response_changed';
    };

/**
 * 纯判定：同 idempotency_key 重复提交时，逐字相同的冻结输入幂等重放，
 * 不同答案/附件/revision ⇒ 冲突（不覆盖、不丢已接收作答）。
 *
 * P1-7：幂等键只在【同一 occurrence】内有效 —— 同 key 同答案但不同
 * issuance / evaluation group 是另一次作答事件，不得被误判为幂等重放
 * （否则后续提交会被静默丢弃）。跨 scope 的键是调用方 bug：这里显式报
 * conflict（issuance_mismatch / evaluation_group_mismatch），fail-closed。
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
  if (existing.issuance_id !== incoming.issuance_id) {
    return { outcome: 'conflict', reason: 'issuance_mismatch' };
  }
  if (existing.evaluation_group_id !== incoming.evaluation_group_id) {
    return { outcome: 'conflict', reason: 'evaluation_group_mismatch' };
  }
  const samePayload =
    stableStringify(existing.response_set) === stableStringify(incoming.response_set) &&
    stableStringify(existing.group_evidence) === stableStringify(incoming.group_evidence);
  return samePayload
    ? { outcome: 'same_payload' }
    : { outcome: 'conflict', reason: 'response_changed' };
}
