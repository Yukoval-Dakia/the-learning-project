import { z } from 'zod';

/**
 * 模型拒收引文的脱敏摘要。目标 id 只有真实提交过才记原文；模型声称但不
 * 存在的 id 与引文明文一律只留 sha256 + 长度，绝不落学习者/模型原文。
 * 短引文与短声称 id（< 16 字符）不记 sha256 —— 可枚举短语/短 id 的
 * hash 能被字典还原，只留长度。
 */
export const ModelOutcomeRejectedCitation = z.object({
  /** 哪一类校验没过（与执行器的拒收判定一一对应）。 */
  problem: z.enum(['no_target', 'unknown_slot', 'unknown_evidence', 'non_original_quote']),
  slot_id: z.string().min(1).optional(),
  evidence_id: z.string().min(1).optional(),
  claimed_slot_id_sha256: z.string().min(1).optional(),
  claimed_slot_id_length: z.number().int().min(0).optional(),
  claimed_evidence_id_sha256: z.string().min(1).optional(),
  claimed_evidence_id_length: z.number().int().min(0).optional(),
  quote_sha256: z.string().min(1).optional(),
  quote_length: z.number().int().min(0).optional(),
});
export type ModelOutcomeRejectedCitationT = z.infer<typeof ModelOutcomeRejectedCitation>;

/** 执行期拒收时可引用来源：文字类记数量+总字符，image 证据只记数量。 */
export const ModelOutcomeCitableSource = z.object({
  kind: z.enum(['slot_text', 'text_evidence', 'image_evidence']),
  count: z.number().int().min(0),
  /** 仅文字类来源有总字符；image 证据不记。 */
  total_chars: z.number().int().min(0).optional(),
});
export type ModelOutcomeCitableSourceT = z.infer<typeof ModelOutcomeCitableSource>;

/**
 * 执行期拒收诊断：哪一类校验没过 + 被拒引文摘要 + 当时可引用来源的
 * 计数/长度。挂在 pending outcome 旁（不进 PendingState/unit_results）——
 * ScoringUnitResult 的形状不变，evaluation_id 内容寻址与学习者投影面不受影响；
 * 诊断只随封存的 outcome 与留出题证据落地。
 */
export const ModelOutcomeDiagnostics = z.object({
  check: z.enum([
    'model_declined',
    'citation_validation',
    'decision_criterion_mismatch',
    'cost_cap_exceeded',
  ]),
  /** 前 16 条被拒引文的摘要；真实总数在 rejected_citation_count。 */
  rejected_citations: z.array(ModelOutcomeRejectedCitation).max(16).optional(),
  rejected_citation_count: z.number().int().min(0).optional(),
  citable_sources: z.array(ModelOutcomeCitableSource).optional(),
  decision: z
    .object({
      kind: z.enum(['rule', 'level']),
      criterion_kind: z.string().min(1),
      /** 与冻结 rule/level 一致时记原文 id；不一致时 claimed id 只记 hash+长度（<16 只记长度）。 */
      rule_id: z.string().min(1).optional(),
      rule_id_sha256: z.string().min(1).optional(),
      rule_id_length: z.number().int().min(0).optional(),
      level_id: z.string().min(1).optional(),
      level_id_sha256: z.string().min(1).optional(),
      level_id_length: z.number().int().min(0).optional(),
      points_awarded: z.number().min(0).optional(),
      unit_points: z.number().min(0).nullable(),
    })
    .optional(),
  cost: z
    .object({
      cost_usd_micros: z.number().int().min(0),
      cap_usd_micros: z.number().int().min(0),
    })
    .optional(),
});
export type ModelOutcomeDiagnosticsT = z.infer<typeof ModelOutcomeDiagnostics>;
