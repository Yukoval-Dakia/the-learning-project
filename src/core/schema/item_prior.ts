import { z } from 'zod';

// B1-W1 (ADR-0035 慢热阶段①) — ItemPriorTask LLM 输出形状。
//
// 给一道新题估冷启先验难度 b（logit 尺度，与 θ̂ 同度量）。propose-only 冷启锚；
// item-更新半边锁死（G4），慢热由 fixed-anchor 校准 firm-up。⚠️ prompt 走「抽教学
// 特征推 b」路线——直接 prompt 估难度文献 r≈0（phase2-synthesis-lanes:770）。
export const ItemPriorDraft = z.object({
  b_logit: z.number(), // IRT b，logit 尺度（与 θ̂ 同度量）
  confidence: z.number().min(0).max(1),
  reasoning: z.string().min(1), // 引用教学特征，非「我觉得难」
});
export type ItemPriorDraftT = z.infer<typeof ItemPriorDraft>;
