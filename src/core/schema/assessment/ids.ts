import { z } from 'zod';

// ====================================================================
// YUK-1046 — 统一评估契约 · 身份与 effective head 基座（grounding §3–§4、§11）
// ====================================================================
//
// 本文件只放【身份】原语：opaque id schema、evaluation group 的 effective head、
// 以及 activation 的 CAS 前置条件。全部为纯类型 + 纯确定性函数，无 IO。
//
// 关键语义（grounding §4.3 / §11，不得弱化）：
//   - `revision_id / submission_id / evaluation_group_id` 对新 runtime 必填
//     （min(1) 字符串，不做 `.optional()`）；历史未知是另一种显式记录类型
//     （见 judgment.ts 的 HistoricalUnknownSubmission），不用可选字段让新请求
//     逃避冻结。
//   - `expected_effective_id` 是 REQUIRED null-or-id：初次 activation 传 null，
//     替换传明确的旧 effective id；禁止省略当无条件覆盖（防 ABA）。
//   - id 是 opaque token：客户端/消费者不得解析其内部结构、不得按 label/数组
//     index/相同文本自动认定身份连续（§3.1）。

/** Opaque published-revision identity. 新 runtime 必填，不可选。 */
export const RevisionId = z.string().min(1);
export type RevisionIdT = z.infer<typeof RevisionId>;

/** Opaque issuance identity（一次发题实例；绑定 revision + parts + 材料呈现）。 */
export const IssuanceId = z.string().min(1);
export type IssuanceIdT = z.infer<typeof IssuanceId>;

/** Opaque submission identity（一份已接收作答；含 202 接收即守恒，D5）。 */
export const SubmissionId = z.string().min(1);
export type SubmissionIdT = z.infer<typeof SubmissionId>;

/**
 * Opaque evaluation-group identity。一个 group 覆盖一次联合判分
 * （solo 单题为 1-submission group；paper 多 slot 可为多 submission 联合组）。
 */
export const EvaluationGroupId = z.string().min(1);
export type EvaluationGroupIdT = z.infer<typeof EvaluationGroupId>;

/** Opaque evaluation identity。一次评估尝试；重试身份 ≠ 学习事实身份。 */
export const EvaluationId = z.string().min(1);
export type EvaluationIdT = z.infer<typeof EvaluationId>;

// ---------- effective head（grounding §11） ----------

/**
 * 每个 evaluation group 一行的 effective head。创建 submission/group 时同时建立：
 * `effective_evaluation_id = null`、`generation = 0`；每次有效 activation +1。
 * “当前生效结果”与“原始执行收据”是两条不同的读（§9），head 只承载前者。
 */
export const EvaluationEffectiveHead = z.object({
  evaluation_group_id: EvaluationGroupId,
  submission_id: SubmissionId,
  /**
   * null = 尚无生效评估（初始态）。REQUIRED null-or-id —— 不是 optional：
   * “还没有”是显式 null，不是缺字段。
   */
  effective_evaluation_id: EvaluationId.nullable(),
  /** CAS generation，防 ABA；单调递增。 */
  generation: z.number().int().min(0),
});
export type EvaluationEffectiveHeadT = z.infer<typeof EvaluationEffectiveHead>;

/**
 * `activateEvaluation` 的 CAS 前置条件（§4.3 Interface 语义）。
 * `expected_effective_id` REQUIRED null-or-id：省略即 parse 失败 —— 这是
 * “禁止省略当无条件覆盖”的类型级执行。`expected_generation` 同理必填。
 */
export const ActivateEvaluationIntent = z.object({
  evaluation_id: EvaluationId,
  /** null = 期望尚无生效评估（首次）；非 null = 期望替换该旧 id。不可省略。 */
  expected_effective_id: EvaluationId.nullable(),
  expected_generation: z.number().int().min(0),
});
export type ActivateEvaluationIntentT = z.infer<typeof ActivateEvaluationIntent>;

/** CAS 判定结果。'ok' 之外全部是冲突 —— 调用方不得静默覆盖（D4：否则保持 held）。 */
export type ActivationCasOutcome =
  | { ok: true }
  | { ok: false; conflict: 'stale_head' | 'already_effective' | 'generation_mismatch' };

/**
 * 纯确定性 CAS 判定（不发 IO；锁序/事务由调用方负责）。
 *
 * - `stale_head`：head 的 effective id 已不是 intent 期望的旧值（或已从 null 前移）；
 * - `already_effective`：该 evaluation 已是当前生效结果（幂等重放应判 ok 之外
 *   的显式分支 —— 这里返回冲突，由调用方决定幂等语义，见 §3.3 同版复核表）；
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
