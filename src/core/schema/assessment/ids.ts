import { z } from 'zod';

// 身份原语：opaque id、evaluation group 的 effective head、activation 的 CAS
// 前置条件。纯类型 + 确定性函数，无 IO。
//
// 关键语义：
//   - `revision_id / submission_id / evaluation_group_id` 对新 runtime 必填；
//     历史未知用显式的 HistoricalUnknownSubmission 记录，不用 optional 让新请求
//     逃避冻结。
//   - `expected_effective_id` 是必填 null-or-id：初次 activation 传 null，替换传
//     旧 effective id；省略即 parse 失败（防 ABA）。
//   - id 是 opaque token：不得解析内部结构，也不得按 label / 数组 index / 相同
//     文本认定身份连续。

/** Opaque published-revision identity. */
export const RevisionId = z.string().min(1);
export type RevisionIdT = z.infer<typeof RevisionId>;

/** 一次发题实例：绑定 revision、parts 与材料呈现。 */
export const IssuanceId = z.string().min(1);
export type IssuanceIdT = z.infer<typeof IssuanceId>;

/** 一份已接收作答；202 接收即守恒。 */
export const SubmissionId = z.string().min(1);
export type SubmissionIdT = z.infer<typeof SubmissionId>;

/** 一次联合判分；solo 单题为 1-submission group。 */
export const EvaluationGroupId = z.string().min(1);
export type EvaluationGroupIdT = z.infer<typeof EvaluationGroupId>;

/** 一次评估尝试；重试身份 ≠ 学习事实身份。 */
export const EvaluationId = z.string().min(1);
export type EvaluationIdT = z.infer<typeof EvaluationId>;

// ---------- effective head ----------

/**
 * 每个 evaluation group 一行的 effective head。创建 submission/group 时同时建立：
 * `effective_evaluation_id = null`、`generation = 0`；每次有效 activation +1。
 * “当前生效结果”与“原始执行收据”是两条不同的读，head 只承载前者。
 */
export const EvaluationEffectiveHead = z.object({
  evaluation_group_id: EvaluationGroupId,
  submission_id: SubmissionId,
  /**
   * null = 尚无生效评估。必填 null-or-id：“还没有”是显式 null，不是缺字段。
   */
  effective_evaluation_id: EvaluationId.nullable(),
  /** CAS generation，防 ABA；单调递增。 */
  generation: z.number().int().min(0),
});
export type EvaluationEffectiveHeadT = z.infer<typeof EvaluationEffectiveHead>;

/**
 * `activateEvaluation` 的 CAS 前置条件。两个 expected_* 都必填 —— 省略即 parse
 * 失败，从类型层禁止把“无条件覆盖”写成省略。
 */
export const ActivateEvaluationIntent = z.object({
  evaluation_id: EvaluationId,
  /** null = 期望尚无生效评估（首次）；非 null = 期望替换该旧 id。 */
  expected_effective_id: EvaluationId.nullable(),
  expected_generation: z.number().int().min(0),
});
export type ActivateEvaluationIntentT = z.infer<typeof ActivateEvaluationIntent>;

/** CAS 判定结果。'ok' 之外全是冲突，调用方不得静默覆盖。 */
export type ActivationCasOutcome =
  | { ok: true }
  | { ok: false; conflict: 'stale_head' | 'already_effective' | 'generation_mismatch' };

/**
 * 纯确定性 CAS 判定（不发 IO；锁序/事务由调用方负责）。
 *
 * - `stale_head`：head 的 effective id 已不是 intent 期望的旧值；
 * - `already_effective`：该 evaluation 已是当前生效结果，由调用方决定幂等语义；
 * - `generation_mismatch`：generation 与期望不符（ABA 防线）。
 */
export function resolveActivationCas(
  head: EvaluationEffectiveHeadT,
  intent: ActivateEvaluationIntentT,
): ActivationCasOutcome {
  if (head.effective_evaluation_id === intent.evaluation_id) {
    return { ok: false, conflict: 'already_effective' };
  }
  if (head.effective_evaluation_id !== intent.expected_effective_id) {
    return { ok: false, conflict: 'stale_head' };
  }
  if (head.generation !== intent.expected_generation) {
    return { ok: false, conflict: 'generation_mismatch' };
  }
  return { ok: true };
}
