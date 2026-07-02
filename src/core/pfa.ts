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
// OWNER-FIXED PRIORS — gamma/rho 是 owner 拍板、经 code review 的模块常量，不是等某个
//   refit job 回填的占位。核实（穷尽 grep）：本仓库不存在任何 refit gamma/rho 的
//   job/script/call site——recalibration_nightly.ts（YUK-361 已 ship 部分）只用
//   active-PPI/AIPW refit item 难度 b/b_calib，从不碰 gamma/rho。它们与 ELO_K_GLOBAL /
//   DIFFICULTY_PROXY_WEIGHT（theta.ts）同档：跨学习者作用域的结构系数，非 θ̂ 那样的
//   per-user 潜变量。按 ADR-0035 的 n=1 doctrine 外推：经典 PFA 对 gamma/rho 的跨学生
//   logistic 回归拟合（Pavlik/Cen/Koedinger 2009）在 n=1 无 cohort 可回归，故不可能
//   runtime 在线拟合这两个系数。IOU（forward-looking，未撤销）：若将来接通标定，这些
//   常量应被替换为 per-KC / 全局标定值——在 owner 另行裁决前，一律按 owner-fixed const
//   对待；retune 只经带明确理由的 reviewed PR（见下方 gamma/rho docblock），绝不走自动
//   nightly job。

import { POLY_SIGMOID_ENABLED, polySigmoid } from './poly-exp';

/** Logistic CDF（与 core/theta.ts 的 1PL ICC 同形）。
 * decision ②（dark-ship，POLY_SIGMOID_ENABLED=false 今日）：flip 后走共享 bit-exact
 * `polySigmoid`，否则 live `Math.exp`（与今日 byte-identical）。 */
function sigmoid(x: number): number {
  return POLY_SIGMOID_ENABLED ? polySigmoid(x) : 1 / (1 + Math.exp(-x));
}

/**
 * OWNER-FIXED PFA 系数（跨学习者结构常量，非占位）。见文件头：本仓库无任何 refit γ/ρ 的
 * job，recalibration_nightly.ts 只 refit item 难度 b。这些值经 reviewed PR 设定，
 * IOU 保留——若将来接通标定，应被替换为 per-KC / 全局标定值：
 *   - γ (success) = 0.5 — 每次答对的 logit 增益（正，单调升 p(L)）。
 *   - ρ (fail)    = −0.25 — 每次答错的 logit 增益（负，单调降 p(L)）。
 *     |ρ| < γ（保持 2:1 比），反映「答错的诊断信息量通常弱于答对」的常见 PFA 形态。
 *
 * RETUNE（YUK-539，was γ=0.4 / ρ=−0.2）：把硬锚 prereq（β≈3）解锁所需的干净连对从 10 降到
 *   8（K(β)=ceil((0.8473+β)/γ)），缓解 starvation；同比降 ρ 保 2:1。冷启假掌握（β=0
 *   三连对即翻过 0.7）不靠 γ 修——它由 learnable-frontier 的 evidence-count floor 独立挡住
 *   （见 FRONTIER_MASTERY_MIN_EVIDENCE），故此处可安全抬 γ。文献（Pavlik/Cen/Koedinger
 *   2009 per-skill 跨学生回归）不给可移植的绝对量级，只支持 γ>0>ρ、|ρ|<γ 的定性结构——
 *   本 retune 是同比有界微调，非「文献推导的绝对值」。
 * 触发未来再调的条件：真实作答数据显示 β 分布 / 阈值跨越行为系统性异于本分析假设，或
 *   difficulty-anchor-cluster 改变 β 的推导方式——而非「某个用户想感觉更/更少掌握」（那是
 *   MASTERED_PL_THRESHOLD / evidence floor 的旋钮，不是 γ/ρ 的）。
 * 默认 β=0（KC 无 item_calibration.b 锚时的中性难度）。
 */
export const PFA_GAMMA = 0.5; // was 0.4 (YUK-539 retune, Candidate B)
export const PFA_RHO = -0.25; // was -0.2 (YUK-539 retune, Candidate B)

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
 * Owner-fixed 呈现常量（无 refit job 回填——见 pfa.ts 文件头）。1.0 = default cold-start
 * precision（precision=1，「几乎没证据」）下的 SE。仅在 CI 带呈现本身需要重标定时才调它；
 * 与 γ/ρ 无关，也与 frontier-pool gating 无关（那是 learnable-frontier.ts 的
 * FRONTIER_MASTERY_MIN_EVIDENCE 管的另一件事——本 SE 阈值在 β=0 下仅 ~1 次作答即跨到
 * 「confident」，故 NOT 能当证据门用）。
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
