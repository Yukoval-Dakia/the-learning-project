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
 * 多 KC 合取 credit-assignment（owner 拍板 MLE，review SF-1 修复）。
 *
 * 一道挂多 KC 的题产生 ONE outcome，多个 θ_k 要更新 = credit assignment。模型取
 * 合取（conjunctive / DINA 式「需要所有 KC 才做对」）：P_item = ∏ σ(θ_j − b)。
 * 返回每 KC 的 credit 项（log 似然对 θ_k 的梯度，无量纲），caller 各乘自己的 K
 * （+ bWeight）。
 *
 *   correct (x=1): credit_k = (1 − p_k)
 *   wrong   (x=0): credit_k = −(1 − p_k) · P_item/(1 − P_item)
 *
 * (1−p_k) 灵敏度 ⇒ 最弱的 KC 双向都动最多（owner 拍的 MLE）。题目级 surprise
 * 因子 (outcome−P_item 的等价) 取代了旧的 per-KC 残差 (outcome−p_k)——后者在
 * 两端自我抵消，导致「已诊断为弱的 KC 答错几乎不降」（与意图反向，review SF-1）。
 *
 * n=1 精确退化为标准 Elo：correct→(1−p)=(x−p)，wrong→−p=(x−p)。
 *
 * 数值守护：wrong 分支 odds 比 P_item/(1−P_item) 在全强 KC（P_item→1）时是大
 * surprise，自然趋向 normalized blame（量级 ≤ 1），但 float 下 P_item 舍入到 1.0
 * 会让 odds 爆掉——故 (a) 分母 floor 1e-9，(b) 每 KC credit 量级 clamp 到 1（一次
 * 意外 miss 不该比一次自信 correct 移动 θ̂ 更多）。
 */
export function conjunctiveCredits(thetas: number[], b: number, outcome: 0 | 1): number[] {
  const ps = thetas.map((t) => expectedScore(t, b));
  if (ps.length <= 1) {
    // 单 KC（或空）→ 标准 Elo credit (outcome − p)。
    return ps.map((p) => outcome - p);
  }
  if (outcome === 1) {
    return ps.map((p) => 1 - p);
  }
  // wrong: −(1−p_k) · P_item/(1−P_item)，clamp 量级 ≤ 1。
  const pItem = ps.reduce((acc, p) => acc * p, 1);
  const odds = pItem / Math.max(1 - pItem, 1e-9);
  return ps.map((p) => Math.max(-(1 - p) * odds, -1));
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
