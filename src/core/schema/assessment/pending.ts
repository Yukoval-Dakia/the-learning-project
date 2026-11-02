import { z } from 'zod';

// 显式未决态。未决不是分数：材料缺失 / 不可判分 / 证据不可读 / 待复核都以显式
// 类型表达，绝不落成伪零分。pending unit 不产生 points，聚合进入 unresolved 或
// 按 policy 阻塞，由 settlement 决定重试或人工复核。
//
// 状态互不冒充：blank 是完整提交中的显式空作答（仅 blank_scores_zero 时计 0，
// 属 scored）；缺失、无法解析、证据不足、基础设施失败、待复核与历史缺失分别走
// 下面各自的 reason。

/** 需要复核的触发源。verify_suspended：题源 verify 挂起期间的提交。 */
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
  /** 判分所需共享材料缺失/不可得（不得猜材料）。 */
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
  /** 证据可读但不足以判分（如只需原媒体证据而只有转写）。 */
  z.object({
    reason: z.literal('insufficient_evidence'),
    detail: z.string().default(''),
  }),
  /** 无获准执行器可判该单元（能力切片未准入 / 原媒体分析能力缺失）。 */
  z.object({
    reason: z.literal('unjudgeable'),
    detail: z.string().default(''),
  }),
  /** 结果已产生但需复核后才可生效，否则保持 held。 */
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
   * 但不得用当前 revision 补造当时所见。
   */
  z.object({
    reason: z.literal('historical_unresolved'),
    detail: z.string().default(''),
  }),
]);
export type PendingStateT = z.infer<typeof PendingState>;
