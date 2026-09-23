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

// ─── YUK-376 — LLaSA 学生模拟变体（opt-in，不动默认 feature→b 路径）────────
//
// LLaSA「LLMs are Students at Various Levels」（EMNLP 2024）：让 LLM 扮演不同
// 能力档的学习者**实际作答**，从各档答对率反推题目难度 b——间接学生模拟，
// 而非直接问难度（direct zero-shot 已被 spike 证伪，见 ADR-0043「b_anchor 来源」节
// 与 docs/design/2026-06-15-b-anchor-feasibility-spike.md）。
//
// 形状 = 单次结构化输出：每档 θ 模拟若干名学生作答（学生看不到参考答案），
// 对照 reference_md 判对错；确定性反推（src/core/item-prior-llasa.ts）把
// 作答分布折回 ItemPriorDraftT（b_logit/confidence/reasoning），复用同一条
// applyItemPrior 写路径，provenance 用 source='llm_prior_llasa' 区分。

/** 模拟学生能力档（logit 尺度，与 θ̂ 同度量）：θ=0 是该科典型中等学习者。 */
export const LLASA_ABILITY_TIERS = [-2, -1, 0, 1, 2] as const;
/** 每档模拟学生数（同一调用内独立作答；2 名/档 → 每档 p̂ ∈ {0, 0.5, 1}）。 */
export const LLASA_STUDENTS_PER_TIER = 2;

export const ItemPriorLlasaResponse = z.object({
  // 该模拟学生的能力档 θ（logit）。范围放宽到 [-3,3]：模型偶发插值档
  // （如 1.5）仍是合法反推点，invert 侧按实际 θ 值聚合。
  theta_level: z.number().min(-3).max(3),
  // 该学生的作答全文（不允许空——空作答无法判定对错，宁可整条作废）。
  student_answer_md: z.string().min(1),
  // 对照 reference_md（缺失时按题面本身正确性）判定的对错。
  correct: z.boolean(),
  // 一句话说明该生对/错在哪（漏掉的知识点/掉进的坑），供 reasoning 与审计。
  note: z.string().min(1),
});
export type ItemPriorLlasaResponseT = z.infer<typeof ItemPriorLlasaResponse>;

export const ItemPriorLlasaDraft = z.object({
  // 全部模拟作答。下限 = 档数（每档至少 1 条）；覆盖度不足由 invert 侧硬拒。
  simulated_responses: z.array(ItemPriorLlasaResponse).min(LLASA_ABILITY_TIERS.length),
  reasoning: z.string().min(1),
});
export type ItemPriorLlasaDraftT = z.infer<typeof ItemPriorLlasaDraft>;
