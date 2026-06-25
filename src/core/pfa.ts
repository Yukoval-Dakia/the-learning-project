// B1 (ADR-0035 决定#2) — PFA (Performance Factors Analysis) p(L) 掌握诊断投影。
//
// 纯函数、无 IO、跨学科（core/ 边界）。这是 ADR-0035 「`p(L)`（PFA logistic 掌握
// 诊断）」的承重数学：取代 deprecated `knowledge_mastery` view 的 `evidence<3→0.5`
// 占位，回答「此刻会不会 / 迁移得了吗」，喂诊断展示 + 调度 what 信号。
//
// 符号约定（**ADR-0035 line 22 是唯一真相**）:
//   logit(p) = β_kc + γ·success_count + ρ·fail_count
// 其中 β 来自 item difficulty 锚（KC 代表性 hard-track item_calibration.b），γ 是
// 答对的学习率（正），ρ 是答错的学习率（**负**——答错 LOWERS p(L)）。
//
// ⚠️ 任务书把签名写成 `beta + gamma*success - rho*fail`（即 ρ 取正、减号外提）。
//   本模块**遵循 ADR-0035 的 `+ ρ·fail` 规范形态**（ρ 自带符号、与标准 PFA
//   Pavlik 2009 一致），而非任务书的 `- ρ·fail`。二者数学等价（任务书 ρ_task =
//   −ρ_adr），但 ADR 是单一真相，故 `pfaLogit` 直接相加、ρ 默认值为负。
//
// β 的难度语义（关键，ADR-0035 line 22-23 + 决定#1）:
//   PFA 的 β 是「logistic 回归 KC 难度截距」，与 FSRS D / IRT b 同 logit 语义但
//   **需 linking 对齐、非等号**。本投影用 KC 代表性 hard-track item_calibration.b
//   作 β：题更难（b 更大）⇒ β 更大 ⇒ **固定 success/fail 下 p(L) 更低**（同样的
//   答对历史，在更难的题上证明的掌握度更低）。这要求 β 在 logit 里以**负号**进入：
//   logit(p) = γ·success + ρ·fail − β。见 `pfaLogit` 实现注释。
//
// PHASE-DEFERRED — gamma/rho 系数当前是 hardcode 的合理默认值，**待 PFA nightly
//   refit 的统计验证**（YUK-361）。owner 裁定：现在就建、hardcode 系数 + flag。
//   refit 落地前，调本模块的 caller 不该假设这些值是标定真值。

import { POLY_SIGMOID_ENABLED, polySigmoid } from './poly-exp';

/** Logistic CDF（与 core/theta.ts 的 1PL ICC 同形）。
 * decision ②（dark-ship，POLY_SIGMOID_ENABLED=false 今日）：flip 后走共享 bit-exact
 * `polySigmoid`，否则 live `Math.exp`（与今日 byte-identical）。 */
function sigmoid(x: number): number {
  return POLY_SIGMOID_ENABLED ? polySigmoid(x) : 1 / (1 + Math.exp(-x));
}

/**
 * PHASE-DEFERRED — PFA 系数 hardcode 默认值。
 *
 * 待 PFA nightly refit 的统计验证（YUK-361）。owner 裁定：现在就建、hardcode +
 * flag。refit 接通后这些常量应被替换为 per-KC / 全局标定值（届时本投影应从标定表
 * 读 γ/ρ，而非 hardcode）。当前值是「合理默认」，**非实测真值**：
 *   - γ (success) = 0.4 — 每次答对的 logit 增益（正，单调升 p(L)）。
 *   - ρ (fail)    = −0.2 — 每次答错的 logit 增益（负，单调降 p(L)）。
 *     绝对值 < γ，反映「答错的诊断信息量通常弱于答对」的常见 PFA 形态，但这是占位
 *     直觉、非标定结论。
 * 默认 β=0（KC 无 item_calibration.b 锚时的中性难度）。
 */
export const PFA_GAMMA = 0.4;
export const PFA_RHO = -0.2;

/**
 * Flag — p(L) 是否启用难度感知 β（KC 代表性 hard-track b）。
 *
 * PHASE-DEFERRED：owner 裁定「现在就建、hardcode 系数 + flag」。本 flag 当前恒 true
 * （B1 FULL path 已上线，p(L) 是 live projection）。保留 flag 是为给「系数/β 标定
 * 出问题需快速回落到 σ(θ̂)@b=0 interim 投影」留一个开关位——但回落逻辑不在本 wave，
 * 读侧（mastery/state.ts）当前无条件走难度感知 p(L)。
 */
export const PFA_DIFFICULTY_AWARE = true;

/**
 * PFA logit：logit(p) = γ·success + ρ·fail − β。
 *
 * 符号约定 reconcile（见文件头）:
 *   - ADR-0035 line 22 规范形态是 `β_kc + γ·success + ρ·fail`，其中 β_kc 是
 *     「logistic 回归 KC 难度截距」。当 β_kc 直接作截距时，更大的难度截距会**抬高**
 *     baseline logit——这与「题更难 ⇒ 同样答对历史证明的掌握更低」相反。
 *   - 故本实现把 β（= KC 代表性 item_calibration.b，IRT 难度 logit）以**负号**进
 *     logit：logit(p) = γ·success + ρ·fail − β。这是 ADR-0035 决定#1「β 与 b 同
 *     logit 语义、需 linking 对齐、非等号」的落地——我们用 IRT b 作 β 的**难度方向**
 *     来源（b 大=题难=p(L) 应低），而非把 b 当回归截距直接相加。
 *
 * @param beta KC 代表性难度（hard-track item_calibration.b，logit 尺度）。无锚时传 0。
 * @param gamma 答对学习率（正，{@link PFA_GAMMA}）。
 * @param rho 答错学习率（负，{@link PFA_RHO}）。
 * @param success 累积答对次数（mastery_state.success_count）。
 * @param fail 累积答错次数（mastery_state.fail_count）。
 */
export function pfaLogit(
  beta: number,
  gamma: number,
  rho: number,
  success: number,
  fail: number,
): number {
  // logit = γ·success + ρ·fail − β（β 大 ⇒ logit 小 ⇒ p(L) 低；难度感知）。
  return gamma * success + rho * fail - beta;
}

/**
 * p(L) = σ(pfaLogit(...))：已学会该 KC 的概率（PFA logistic 掌握诊断）。
 *
 * 冷启（success=0, fail=0, beta=0）→ logit=0 → p(L)=0.5（中性中点，非占位）。
 * 单调性：success↑ → p(L)↑；fail↑ → p(L)↓；beta↑（题更难）→ p(L)↓。
 */
export function pLearned(
  beta: number,
  gamma: number,
  rho: number,
  success: number,
  fail: number,
): number {
  return sigmoid(pfaLogit(beta, gamma, rho, success, fail));
}

/** p(L) 置信带 — 点估计 + 上下界 + low-confidence 旗。 */
export interface PLearnedBand {
  /** 下界（点 logit − thetaSe，过 σ）。 */
  lo: number;
  /** 点估计（pointLogit 过 σ）。 */
  point: number;
  /** 上界（点 logit + thetaSe，过 σ）。 */
  hi: number;
  /** θ̂ 仍不确定时为 true（thetaSe ≥ {@link LOW_CONFIDENCE_SE_THRESHOLD}）。 */
  lowConfidence: boolean;
}

/**
 * Low-confidence 阈值（ADR-0035 confidence-interval / low-confidence 呈现）:
 * θ̂ 的标准误 ≥ 此值时，点估计不可信，呈现应展示 CI 带而非裸点。
 *
 * PHASE-DEFERRED — 阈值 1.0 是合理默认（SE=1 即 default precision 的弱先验态，
 * 「几乎没证据」）；精确阈值待 refit/呈现调优（YUK-361）。
 */
export const LOW_CONFIDENCE_SE_THRESHOLD = 1.0;

/**
 * 把点 logit + θ̂ 标准误转成 p(L) 置信带：在 logit 尺度上 ±thetaSe，各过 σ 得
 * (lo, point, hi)。thetaSe 越大 → 带越宽。thetaSe ≥ {@link LOW_CONFIDENCE_SE_THRESHOLD}
 * → lowConfidence=true（点估计不可信，呈现应让位给带）。
 *
 * 注：CI 在 logit 尺度对称、过 σ 后在 p 尺度非对称（边缘压缩），这是 logit-normal
 * 近似的正确行为——靠近 0/1 的带自然变窄。
 *
 * @param pointLogit p(L) 的点 logit（pfaLogit 的输出）。
 * @param thetaSe θ̂ 的标准误（core/theta.ts thetaSe，从 mastery_state.theta_precision 派生）。
 */
export function pLearnedBand(pointLogit: number, thetaSe: number): PLearnedBand {
  const se = Math.max(thetaSe, 0);
  return {
    lo: sigmoid(pointLogit - se),
    point: sigmoid(pointLogit),
    hi: sigmoid(pointLogit + se),
    lowConfidence: se >= LOW_CONFIDENCE_SE_THRESHOLD,
  };
}
