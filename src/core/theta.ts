// B1-W1 (ADR-0035 阶段② Elo/θ 追踪) — 纯函数 Elo θ̂ 在线更新。
//
// 只更新 θ̂（个体能力，logit 尺度）；b 是锁死外部锚，永不回写（G4 红线，
// item-更新半边 n=1 结构性失效）。喂 PFA p(L) 诊断维，绝不碰 FSRS R 调度维。
//
// K schedule 设计裁决（VERIFY:elo-k-schedule，1/√n REFUTED）:
//   owner 主线场景是非平稳（在学、θ 上升）。1/√(evidence_count) 单调衰减是
//   平稳目标收敛工具，套到上升 θ 会产生 downward lag bias（稳定停在过去能力）。
//   故本 wave 用「有界 K + 冷启段高 K + 时间折扣」轻量退路（VERIFY 选项 A），
//   而非不确定性驱动 K（选项 B，需 RD/urn-count 后验机器，本 wave 太重，defer Wave2）。
//   K 不单调衰减到 0：保 kFloor 让 θ̂ 永远保留追上升能力的自由度。
//
// θ̂_min 分栏注意（防后人误用）：ADR-0042 的 θ̂_min 是**选题/MFI 聚合语义**
//   （ex-ante 选哪道题），不是更新语义（ex-post 这道题怎么动 θ̂）。本模块只做
//   ex-post 在线更新；选题聚合不在本 wave 范围。

/** Logistic CDF — the 1PL/Rasch item characteristic curve P = σ(θ - b). */
function logistic(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Expected score under the 1PL ICC: P(correct) = σ(θ - b).
 * Exposed so the credit-assignment layer (mastery/state.ts) can read p(L_k)
 * from θ̂ without re-deriving the logistic.
 */
export function expectedScore(theta: number, b: number): number {
  return logistic(theta - b);
}

export interface EloKConfig {
  /** 冷启段步长（前 coldStartN 次）。logit 尺度，占位待标定。 */
  kCold?: number; // default 0.4
  /** 稳态步长下限——非平稳保护，永不衰到 0（VERIFY:elo-k-schedule 选项A）。 */
  kFloor?: number; // default 0.12
  /** 冷启段长度——此段 θ̂ 由 LLM 先验主导，K 大，最不该衰（VERIFY 第4点）。 */
  coldStartN?: number; // default 4
}

/**
 * K 因子：冷启段返回 kCold，之后返回 kFloor（有界，不单调衰减）。
 * 禁用 1/√(evidence_count)（VERIFY:elo-k-schedule REFUTED）。
 */
export function eloK(evidenceCount: number, cfg: EloKConfig = {}): number {
  const kCold = cfg.kCold ?? 0.4;
  const kFloor = cfg.kFloor ?? 0.12;
  const coldStartN = cfg.coldStartN ?? 4;
  return evidenceCount < coldStartN ? kCold : kFloor;
}

/**
 * 单 KC θ̂ 更新：(θ, b, outcome, k, weight?) → newθ。
 * weight = credit-assignment 责任权重（多 KC 分摊，VERIFY:multi-kc）+ 弱锚降权
 * （difficulty_proxy 时 ×0.3，VERIFY:difficulty-logit-map）。default 1。
 * b 是入参常量——此函数无任何回写 b 的出口（G4）。
 */
export function updateTheta(
  theta: number,
  b: number,
  outcome: 0 | 1,
  k: number,
  weight = 1,
): number {
  const expected = expectedScore(theta, b); // 1PL ICC: P = σ(θ - b)
  return theta + k * weight * (outcome - expected);
}

/**
 * difficulty(1-5) → logit b 兜底映射。
 * ⚠️ 占位、非真值（VERIFY:difficulty-logit-map REFUTED「每档1logit任意」）:
 *   序数当 interval，斜率无标定来源。caller 必须配 source='difficulty_proxy'
 *   + 降权 w≈0.3，并优先 item_calibration.b。scale 待 fixed-anchor 慢热校准。
 */
export function difficultyToLogitB(difficulty: number, scale = 0.85): number {
  return (difficulty - 3) * scale;
}

/** 弱锚（difficulty_proxy）的更新降权——VERIFY:difficulty-logit-map 选项2。 */
export const DIFFICULTY_PROXY_WEIGHT = 0.3;
