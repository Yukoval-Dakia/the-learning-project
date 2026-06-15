import { z } from 'zod';

// B1-W1 (ADR-0035 慢热阶段①) — ItemPriorTask LLM 输出形状。
//
// 给一道新题估冷启先验难度 b（logit 尺度，与 θ̂ 同度量）。propose-only 冷启锚；
// item-更新半边锁死（G4），慢热由 fixed-anchor 校准 firm-up。⚠️ prompt 走「抽教学
// 特征推 b」路线——直接 prompt 估难度文献 r≈0（phase2-synthesis-lanes:770）。
export const ItemPriorDraft = z.object({
  // IRT b，logit 尺度（与 θ̂ 同度量）。界 [-6,6]（review NIT）：prompt 软引导
  // -3..+3，但 LLM 偶发极端值（如 50）会写进 item_calibration.b 并满步污染 θ̂
  // （expectedScore(θ,50)≈0 → 答对 Δθ≈k 满步）。越界由 parseItemPriorOutput 的
  // Zod barrier 当本轮跳过（下轮重试），符合现有失败语义。±6 ≈ p∈[0.0025,0.9975]，
  // 远超任何真实题难度，不会误杀合法值。
  b_logit: z.number().min(-6).max(6),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().min(1), // 引用教学特征，非「我觉得难」
});
export type ItemPriorDraftT = z.infer<typeof ItemPriorDraft>;
