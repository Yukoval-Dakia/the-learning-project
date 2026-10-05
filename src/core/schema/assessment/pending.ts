import { z } from 'zod';

// ====================================================================
// YUK-1046 — 统一评估契约 · 显式未决态（grounding §4.4、§3.2、§13）
// ====================================================================
//
// 未决【不是】分数：材料缺失 / 不可判分 / 证据不可读 / 待复核一律以显式类型
// 表达，绝不落成伪零分（“missing 或识别失败不能变 0”）。判分记录中一个
// pending 的 unit 不产生 points，并使聚合结果进入 unresolved（或按 policy
// 阻塞），由后续 lane 的 settlement 决定何时重试/人工复核。
//
// 区分表（§4.4，全部不同状态，不得互相冒充）：
//   空白 blank          —— 完整提交中的显式空作答；仅当 blank_scores_zero
//                          政策明确才计 0（那是 scored，不是 pending）。
//   missing             —— 未提交/缺条目/缺材料（missing_response / missing_materials）。
//   unparseable         —— 提交了但格式无法解释。
//   insufficient        —— 证据在、可读，但不足以支撑判分。
//   infra_failure       —— 基础设施失败（可重试语义由执行器给出）。
//   needs_review        —— 判出来了但需人工/复核确认。
//   historical_unresolved —— 迁移前历史记录缺冻结上下文；保留原始证据可查看，
//                          但不得用当前题面补造当时所见（§3.2/§13）。

/** 需要复核的触发源。verify_suspended：题源 verify 挂起期间的提交（§3.3 表）。 */
export const NeedsReviewTrigger = z.enum([
  'low_confidence',
  'verify_suspended',
  'flagged',
  'manual_request',
]);

export const PendingState = z.discriminatedUnion('reason', [
  /** 必需槽位缺条目（missing —— 不同于主动空白）。 */
  z.object({
    reason: z.literal('missing_response'),
    slot_ids: z.array(z.string().min(1)).min(1),
  }),
  /** 判分所需共享材料缺失/不可得（§交付语义：不得猜材料）。 */
  z.object({
    reason: z.literal('missing_materials'),
    material_ids: z.array(z.string().min(1)).min(1),
  }),
  /** 提交内容格式无法解释（如数值槽给了非数值文本、公式 parse 失败）。 */
  z.object({
    reason: z.literal('unparseable_response'),
    slot_id: z.string().min(1),
    detail: z.string().default(''),
  }),
  /** 附件证据存在但不可读（损坏/解码失败/扫描不过）。 */
  z.object({
    reason: z.literal('unreadable_evidence'),
    evidence_ids: z.array(z.string().min(1)).min(1),
    detail: z.string().default(''),
  }),
  /** 证据可读但不足以判分（如只需原媒体证据而只有转写 —— §7.2）。 */
  z.object({
    reason: z.literal('insufficient_evidence'),
    detail: z.string().default(''),
  }),
  /** 无获准执行器可判该单元（能力切片未准入 / 原媒体分析能力缺失）。 */
  z.object({
    reason: z.literal('unjudgeable'),
    detail: z.string().default(''),
  }),
  /** 结果已产生但需复核后才可生效（D4：否则保持 held）。 */
  z.object({
    reason: z.literal('needs_review'),
    trigger: NeedsReviewTrigger,
    detail: z.string().default(''),
  }),
  /** 基础设施失败；retryable 标注是否值得重试（不冒充任何评分结论）。 */
  z.object({
    reason: z.literal('infra_failure'),
    retryable: z.boolean(),
    detail: z.string().default(''),
  }),
  /**
   * 迁移前历史记录缺冻结上下文（无 issued snapshot 等）。可查看原始证据，
   * 但不得用当前 revision 补造当时所见（§3.2/§13 —— native 未决表示）。
   */
  z.object({
    reason: z.literal('historical_unresolved'),
    detail: z.string().default(''),
  }),
]);
export type PendingStateT = z.infer<typeof PendingState>;
