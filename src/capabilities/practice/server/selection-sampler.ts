// YUK-361 Phase 3 Step C1 — 薄 tempered-softmax 选题 sampler（PURE，无 IO，无接线）。
//
// 权威：ADR-0042 编排档2 amendment（docs/adr/0042-...md:46-68，「LLM 出权重 +
// sampler + π_i」）+ ADR-0043 §7（π_i 必须是**真随机抽样的 inclusion probability、
// 满足 positivity**，**非**确定性 top-item 事后归一化）+ impl plan Step C。
// 此 π_i 喂 Phase 6 active-PPI 的 IPW / Horvitz-Thompson rectifier，**必须精确**。
//
// ════════════════════════════════════════════════════════════════════════════
// 抽样方案：Poisson 抽样 + inclusion-probabilities-proportional-to-size (IPPS)，
//          带 clip（πps with capping）。
// ════════════════════════════════════════════════════════════════════════════
//
// 选 Poisson（非固定 K 无放回）的理由：Poisson 抽样的**定义性质**就是「第 i 个
// 候选的边际入选概率恰好等于 π_i」——这正是 Horvitz-Thompson / IPW 无偏估计成立
// 的那个方案。固定 K top/无放回方案里，softmax 概率 q_i **不是** inclusion
// probability，把 q_i 当 π_i 记会悄悄偏置 Phase 6（§7 明令禁止）。
//
// 数学推导：
//   1. q = softmaxProbabilities(weights, T)，Σ q_i = 1，T>0 + clamp ⇒ 所有 q_i>0
//      （FINDING A：softmaxProbabilities 现含指数下溢 clamp，见 selection-signals.ts）。
//   2. 目标期望子集大小 n = targetCount。要 π_i = min(1, λ·q_i) 且 Σ π_i = n。
//   3. 求 λ 的标准「锁定打满的、剩余再分」迭代算法：
//        - free := 全体；rem := n。
//        - 循环：λ := rem / Σ_{j∈free} q_j。把所有 λ·q_j ≥ 1 的 j 锁成 π_j=1，
//          rem -= (锁定个数)，free 去掉它们；直到本轮无新锁定（或 free 空）。
//        - 收敛后 free 内 π_j = λ·q_j（保证 ∈ (0,1)）。
//      该算法保证 Σ π_i = n（除非 n ≥ N，此时全锁成 1，Σ π_i = N）。
//   4. ε-greedy 入选下限（FINDING A 第二洞）：步骤 3 的 raw π 在「某候选权重极度主导
//      + n 小」时会把主导项锁成 π=1、吃光预算 rem → **其余候选 π=0**（即便 q_i>0）。
//      例：n=1、N=2、q≈[1,0]：主导锁 1、rem→0、另一项 λ·q=0·q=0 → positivity 违例。
//      这是 IPPS「固定期望子集大小 + 硬锁 π=1」与「每候选 π>0」的内在张力——单靠
//      softmax clamp（步骤 1）救不了，因为破在 IPPS 层不在 softmax 层。
//      修复：对 0<n<N 的非退化档把 raw π **向均匀入选下限混合**：
//          π'_i = (1−ε)·π_i + ε·(n/N)。
//      性质（见 README 数学，全部成立）：
//        (a) positivity：π'_i ≥ ε·(n/N) > 0（n>0）——**每个 samplable 候选 π_i>0，airtight**。
//        (b) Σ π'_i = (1−ε)·n + ε·(n/N)·N = (1−ε)·n + ε·n = n——**IPPS 子集大小性质精确保全**。
//        (c) 单调：π'_i 对 π_i 仿射递增，π_i 对 q_i 单调 ⇒ 高权 → 高（或相等）π'_i。
//        (d) 上界：n<N ⇒ n/N<1 ⇒ 即便锁定项 π=1，π'=(1−ε)+ε·(n/N)<1，恒 ∈(0,1)，合法。
//        (e) Monte-Carlo：记录的 π_i 即 π'_i，Bernoulli 边际入选 = π'_i，经验频率 ≈ π'_i。
//      ε 取 SAMPLING_EPSILON（极小 exploration 下限）——主导项几乎不受影响（1→~0.999），
//      只把会被清零的极小项抬成极小正值。退化档（n≤0 全 0 / n≥N 全 1）**不混合**（无洞，
//      且 n≥N 时全 1 是正确确定性纳入；n≤0 是显式空抽样）。
//   5. 抽样：每个候选**独立** Bernoulli 入选（rng() < π_i）。这就是 Poisson 抽样
//      ——边际入选概率精确 = π_i，realized 子集大小是均值 n 的随机量。
//      被选中项记录其 π_i（真 inclusion probability，非 per-draw q）。
//
// positivity：T>0 + clamp ⇒ q_i>0 ⇒（0<n<N 时）ε-mix 后 π_i ≥ ε·(n/N) > 0；n≥N 时
//   π_i=1>0。**任何 0<n 的 samplable 候选 π_i>0，end-to-end airtight。** √
// 退化：空候选 → []；targetCount ≥ N → 全部 π_i=1；targetCount ≤ 0 → 全 π_i=0 → []。
//
// rng 可注入（默认 Math.random）以便测试确定化。NOTE：workflow/agent 脚本禁
// Math.random，但本文件是 **production 模块**（真实代码路径），默认 rng 用
// Math.random 是允许的；测试传 seeded rng。

import { softmaxProbabilities } from '@/core/selection-signals';

/**
 * ε-greedy 入选下限（FINDING A 第二洞）。π'_i = (1−ε)·π_i + ε·(n/N) 保证每个 samplable
 * 候选 π_i ≥ ε·(n/N) > 0（positivity airtight），且 Σπ 精确守恒 = n（仿射混合到均匀，
 * 见文件头数学 (a)(b)）。取极小值：主导项 π≈1 几乎不变（1→1−ε+ε/N），只把会被 IPPS 锁定
 * 吃光预算而清零的极小项抬成极小正值——既保 positivity 又不实质扰动 LLM 编排意图。
 */
const SAMPLING_EPSILON = 1e-3;

/** 一条加权候选（来自 SelectionOrchestratorTask 输出）。weight ≥ 0。 */
export interface WeightedCandidate {
  refId: string;
  weight: number;
}

/** 一条被抽中的候选 + 其真 inclusion probability π_i（喂 Phase 6 IPW）。 */
export interface SampledItem {
  refId: string;
  /** 真随机抽样的边际入选概率 π_i ∈ (0,1]（满足 positivity）。 */
  inclusionProbability: number;
}

export interface SampleByWeightOptions {
  /** tempered-softmax 温度 T；必须 > 0（否则 softmaxProbabilities 抛错）。 */
  temperature: number;
  /** Poisson IPPS 的目标期望子集大小 Σπ_i。 */
  targetCount: number;
  /** 可注入 rng（默认 Math.random），测试传 seeded rng 以确定化。 */
  rng?: () => number;
}

/**
 * 计算每个候选的真 inclusion probability π_i（Poisson IPPS + clip）。
 *
 * 纯函数、无随机：给定 q + targetCount 唯一确定 π 向量。抽样（Bernoulli）与
 * π_i 计算分离，便于单测直接断言 π 向量本身（Monte Carlo 测再验证经验频率 ≈ π_i）。
 *
 * @param q softmax 概率（Σ=1，全 >0）
 * @param targetCount 目标期望子集大小 n
 * @returns 与 q 等长的 π 向量。0<n<N 时经 ε-greedy 混合，每个 ∈ (0,1) 且 Σ π_i = n
 *          （positivity airtight + IPPS 子集大小精确守恒）；退化档（n≤0→全0 / n≥N→全1）不混合。
 */
export function inclusionProbabilities(q: number[], targetCount: number): number[] {
  const N = q.length;
  if (N === 0) return [];
  if (!(targetCount > 0)) {
    // n ≤ 0：无可分配，全 0（退化空抽样）。不混合（显式空抽样语义，无 positivity 洞）。
    return q.map(() => 0);
  }
  if (targetCount >= N) {
    // n ≥ N：每个候选都必入（π_i=1）。不混合（全 1 已是正确确定性纳入，无洞）。
    return q.map(() => 1);
  }

  const pi = new Array<number>(N).fill(0);
  // locked[i] = true 表示 i 已锁成 π=1，退出再分配池。
  const locked = new Array<boolean>(N).fill(false);
  let rem = targetCount; // 剩余待分配的期望计数
  let freeSum = q.reduce((a, b) => a + b, 0); // Σ_{j∈free} q_j

  // 「锁定打满的、剩余再分」：每轮可能有新候选 λ·q_j ≥ 1，锁定后重算 λ。
  // 至多 N 轮（每轮至少锁定 1 个，否则收敛跳出）。
  for (let iter = 0; iter < N; iter++) {
    if (freeSum <= 0) break;
    const lambda = rem / freeSum;
    let lockedThisRound = 0;
    for (let i = 0; i < N; i++) {
      if (locked[i]) continue;
      if (lambda * q[i] >= 1) {
        locked[i] = true;
        pi[i] = 1;
        rem -= 1;
        freeSum -= q[i];
        lockedThisRound++;
      }
    }
    if (lockedThisRound === 0) {
      // 收敛：剩余 free 候选都 < 1，赋 π_i = λ·q_i。
      for (let i = 0; i < N; i++) {
        if (!locked[i]) pi[i] = lambda * q[i];
      }
      break;
    }
  }

  // ε-greedy 入选下限（FINDING A 第二洞，0<n<N 档专属）：向均匀入选 n/N 混合，airtight
  //   positivity（π'_i ≥ ε·n/N > 0）+ Σπ 精确守恒 = n（见文件头数学 (a)(b)）。
  //   主导锁定项 π=1 经混合降到 (1−ε)+ε·(n/N) ∈ (0,1)，合法；被锁吃光预算清零的极小项
  //   被抬成 ε·(n/N) > 0。
  const uniform = targetCount / N;
  return pi.map((p) => (1 - SAMPLING_EPSILON) * p + SAMPLING_EPSILON * uniform);
}

/**
 * 按 LLM 权重抽样落题 + 记真 π_i。
 *
 * 流程：weights → softmax(q, T) → Poisson IPPS clip → π 向量 → 独立 Bernoulli 抽样。
 * 见文件头数学推导；π_i 是真随机抽样的边际 inclusion probability（喂 Phase 6 IPW）。
 */
export function sampleByWeight(
  candidates: WeightedCandidate[],
  opts: SampleByWeightOptions,
): SampledItem[] {
  if (candidates.length === 0) return [];

  const rng = opts.rng ?? Math.random;

  // softmaxProbabilities 已含 T≤0 / 非有限 score 守卫 + reduce-max（不重实现）。
  // T>0 ⇒ 所有 q_i>0 ⇒ positivity 前置满足。
  const q = softmaxProbabilities(
    candidates.map((c) => c.weight),
    opts.temperature,
  );

  const pi = inclusionProbabilities(q, opts.targetCount);

  const selected: SampledItem[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const p = pi[i];
    // 独立 Bernoulli 入选（Poisson 抽样）。p=1 必入；p=0 必不入。
    if (rng() < p) {
      selected.push({ refId: candidates[i].refId, inclusionProbability: p });
    }
  }
  return selected;
}
