// YUK-361 Phase 1 (观测先行) — selection-signals 纯策略数学。
//
// Cross-subject 信号数学，归 core/（不依赖 IO，不读 DB）。本 lane **零选题行为
// 变更**：只定义信号类型 + 评分/概率 helper + 持久化结构，**不接进
// composeDailyStream / 不改可见选题顺序**。行为变更（候选收集 + 随机化选题 +
// active-PPI 重标定）是 Phase 3（roadmap Task 7-11）。
//
// MFI（Maximum Fisher Information）= p(1−p)，IRT 2PL 在 a=1 时的 item information。
// theta_precision（chain base YUK-361 Phase 2 产物）给高不确定 θ̂ 降权——不确定性
// 越高（precision 越低）的诊断价值越低，避免在噪声大的能力估计上浪费选题预算。
// 权威 spec：docs/superpowers/plans/2026-06-15-personalized-calibration-roadmap.md §Task4。

import { fisherInformation, thetaSe } from '@/core/theta';

/**
 * 选题候选信号。一条候选（题或卷）一行；选题策略据此打分 + 抽样。
 *
 * thetaHat/thetaPrecision/b 三个 IRT 量在 logit 尺度同度量（B1 foundation）。
 * 缺失时由候选收集层（Phase 3）兜底（theta_hat=0 / theta_precision=1 /
 * difficultyToLogitB 弱锚），本 lane 不收集、不兜底——仅定义形状。
 */
export interface SelectionCandidateSignal {
  refKind: 'question' | 'paper';
  refId: string;
  role: 'due' | 'frontier' | 'diagnostic' | 'new_check' | 'paper';
  /** 个体能力估计 θ̂，logit 尺度。缺失（冷启）由 Phase 3 兜底 0。 */
  thetaHat?: number;
  /** θ̂ 的累积 Fisher information（precision）。缺失由 Phase 3 兜底 1（弱先验）。 */
  thetaPrecision?: number;
  /** IRT 难度 b，logit 尺度（item_calibration.b 或 difficulty 弱锚）。 */
  b?: number;
  /** due 槽内的到期排名（FSRS 决定，越小越早到期）。 */
  dueRank?: number;
  /** recall-locked 变体（原题重背，不进 MFI 评分；Phase 3 标 mfi_eligible:false）。 */
  recallLocked?: boolean;
  /**
   * A3 (YUK-435) — 哪种信息准则算出了 `mfiScore` 字段（provenance）。
   *   'mfi' — 点 MFI（fisherInformation(θ̂, b)）。warm KC / flag off 的默认。
   *   'klp' — KLP 后验加权 Fisher 网格积分（仅 EARLY_KLP_ENABLED && 冷启 KC）。
   * 缺省（recall-locked / 缺 θ̂ 或 b / 卷候选 → 无评分）时为 undefined。
   */
  scoreKind?: 'mfi' | 'klp';

  // ───────────────────────────────────────────────────────────────────────────
  // #52 / ADR-0042 编排档2 amendment（GPT 研究稿 §9.2）——选题不止 MFI 中心。
  // 三个 first-class 信号。computation 状态（不再全部 deferred）：
  //   - examRelevance：仍 deferred（无 cheap reader——无考纲映射数据源）。
  //   - misconceptionRecurrence：**已实现**（P2 D2 / A8）——由 candidate-signals.ts
  //     aggregateMisconceptionRecurrence 按错题家族复发频次算，flag-gated
  //     （MISCONCEPTION_RECURRENCE_ENABLED，默认 OFF → undefined）。见下方字段注。
  //   - transferGap：仍 deferred（无 cheap reader——mastery_state 无 per-kind 粒度）。
  // 值均由候选收集层计算（candidate-signals.ts）；本文件仅定义 type/schema。
  // ───────────────────────────────────────────────────────────────────────────
  /** 考纲相关度 0-1（考点权重）。computation-deferred：仍无 cheap reader（无考纲映射源）。 */
  examRelevance?: number;
  /**
   * 错误观念复发度 0-1（错题家族跨 attempt 复发频次）。**已实现**（P2 D2 / A8）：由
   * candidate-signals.ts:aggregateMisconceptionRecurrence 按 per-learner SELF-STATE
   * tally（KC-based linkage：候选 KC → 题 → mistake_variant.cause_category group-count）
   * 算出，归一化常数 owner-fixed。flag-gated（MISCONCEPTION_RECURRENCE_ENABLED，默认 OFF
   * → undefined）。SELECTION-ONLY：仅经 buildSelectionOrchestratorInput 进 orchestrator
   * prompt，绝不进 θ̂/p(L)/FSRS。无数据 → undefined（NEVER zero-fill）。
   */
  misconceptionRecurrence?: number;
  /** 迁移缺口 0-1（跨情境迁移诊断）。computation-deferred：仍无 cheap reader（无 per-kind 掌握度）。 */
  transferGap?: number;
}

/**
 * MFI 评分：2PL（a=1）的 item information = p(1−p)，p = σ(θ̂ − b)。
 * θ̂ = b 时取最大 0.25（信息量最大处 = 能力与难度匹配处）。
 *
 * 直接复用 theta.ts 的 `fisherInformation`（同一 Rasch item information 公式，
 * 与 θ_precision 累积共用同一真相）——避免 core/ 里同公式两份分叉（选题评分
 * 与 θ̂ 不确定性累积必须用同一 item information 定义，否则两端会悄悄漂移）。
 */
export function mfiScore(thetaHat: number, b: number): number {
  return fisherInformation(thetaHat, b);
}

// ─────────────────────────────────────────────────────────────────────────────
// A3 (YUK-435) — KLP（KL-information-Proxy）冷启选题分 + 制度门控开关。
//
// 问题：点 MFI `fisherInformation(θ̂, b)` 把全部信息押在 ONE 个 θ̂ 点上。冷启段
//   （per-KC evidence_count 极小）θ̂ 还很 volatile（eloK 用大 kCold 让它乱跳），
//   点 MFI 会在一个噪声很大的能力估计上做选题决策——选出的题对真实（未知）能力
//   不一定信息量最高。
//
// 解法：用 θ̂ 的后验不确定性（Gaussian，中心 θ̂、SD = thetaSe(precision)）给 Fisher
//   information 做**后验加权积分**——不押单点，而是对「θ 在后验下可能落的整片区域」
//   求期望 item information。等价于「在不确定 θ̂ 下，这道题预期能提供多少 KC 信息」。
//   这是 KL/KLP（Kullback–Leibler / posterior-weighted information）选题准则的轻量
//   Fisher-grid 近似（owner 锁定形态）。
//
// HONEST framing：增益 MODEST，且只在冷启段（precision 低、SE 宽）显著——precision
//   攒高后 SE→0，网格塌回 θ̂ 一点，KLP → 点 MFI（连续退化，见单测）。故只在
//   evidence_count < EARLY_KLP_N 用 KLP，之后回落点 MFI（candidate-signals.ts 门控）。
//
// FLAG：EARLY_KLP_ENABLED 是 module-level const（镜像 SRT_ENABLED /
//   HIERARCHICAL_ELO_ENABLED 的模式——无 config 表、无 env）。**现 default TRUE
//   = LIVE**（P1 go-live step 2，YUK-361 / YUK-435 已闭环）：冷启 KC（per-KC
//   evidence_count < EARLY_KLP_N）的候选评分走 klpScore（后验加权 Fisher 网格积分），
//   warm KC 仍点 MFI。OFF（false）路径仍是合法的 baseline——只是不再是 default；
//   bitwise baseline regression 经 candidate-signals.db.test.ts 的 explicit
//   false-mock 继续守护。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Master flag for KLP cold-start selection scoring. **Default true (LIVE).**
 *
 * true (default, live) → for cold-start KCs (per-KC evidence_count < EARLY_KLP_N)
 *   the candidate score becomes klpScore(θ̂, b, precision) instead of mfiScore(θ̂, b);
 *   warm KCs (evidence_count ≥ EARLY_KLP_N) still use point MFI (the gate is intact).
 * false → candidate scoring uses point MFI exactly as before for ALL candidates
 *   (klpScore is never reached on the hot path → selection bytes identical to the
 *   pre-A3 baseline). Still a valid path, exercised explicitly via false-mock; just
 *   no longer the default.
 *
 * Composes orthogonally with HIERARCHICAL_ELO_ENABLED (A2) and SRT_ENABLED (A1):
 * those modulate the θ̂ INPUT / credit value; this flag only changes which
 * information functional scores a candidate given (θ̂, b, precision).
 *
 * Flipped to live in YUK-361 P1 go-live step 2 (after SRT + hierarchical Elo went
 * live in #499); the per-KC evidence_count gate keeps the change scoped to the
 * cold-start regime where posterior-weighted information actually helps.
 */
export const EARLY_KLP_ENABLED = true;

/**
 * Cold-start regime length for KLP scoring — KCs with per-KC evidence_count below
 * this use KLP; at/above it, point MFI. Aligned with eloK's coldStartN (=4): the
 * SAME regime where θ̂ is driven by the high-K cold-start step (and is therefore
 * most volatile) is the regime where posterior-weighted information helps most.
 * Above EARLY_KLP_N the SE has shrunk enough that KLP ≈ MFI anyway (continuous
 * degradation), so the regime gate is honest, not arbitrary.
 */
export const EARLY_KLP_N = 4;

/** KLP 后验加权 Fisher 网格的采样点数（θ̂ ± 3·SE 上等距）。21 点 ≈ ±3σ 充分覆盖。 */
const KLP_GRID_N = 21;
/** 网格半宽（以 SE 为单位）。±3·SE 覆盖 ~99.7% 后验质量。 */
const KLP_GRID_HALF_WIDTH_SE = 3;

/**
 * KLP 评分：θ̂ 后验下 item information 的**后验加权积分**（posterior-weighted Fisher
 * grid integral）。
 *
 *   后验：θ ~ Normal(θ̂, SE²)，SE = thetaSe(precision)（与 θ_precision 累积同一真相）。
 *   网格：KLP_GRID_N(=21) 个点等距覆盖 [θ̂ − 3·SE, θ̂ + 3·SE]。
 *   权重：w_i = φ((θ_i − θ̂)/SE) = exp(−½ z²)（未归一化高斯密度；归一化常数在比值
 *         中抵消，故省）。
 *   返回：Σ w_i · fisherInformation(θ_i, b) / Σ w_i —— θ 后验下的期望 item information。
 *
 * 与点 MFI 的关系（连续退化，单测钉死）：
 *   - precision → ∞ ⇒ SE → 0 ⇒ 网格塌到 θ̂ 一点 ⇒ KLP → fisherInformation(θ̂, b) = MFI。
 *   - precision 低 ⇒ SE 宽 ⇒ 后验把质量摊到 θ̂ 两侧 ⇒ KLP 比点 MFI 更「保守」（在
 *     I(θ̂) 处于峰值附近时 KLP < MFI，因两侧信息更低）。冷启段正是 precision 低、
 *     θ̂ volatile 之处——此时 KLP 不押单点噪声估计。
 *
 * 取值域：fisherInformation ∈ (0, 0.25]，加权平均不出界 ⇒ KLP ∈ (0, 0.25]。
 * precision 非正由 thetaSe 内部 floor（1e-9）兜底 ⇒ SE 有限 ⇒ 不抛错、不 NaN。
 *
 * 纯函数、零 IO；与 mfiScore 同享 fisherInformation 真相（无第二份 item information）。
 */
export function klpScore(thetaHat: number, b: number, thetaPrecision: number): number {
  const se = thetaSe(thetaPrecision); // floors precision at 1e-9 → SE finite & > 0
  const lo = thetaHat - KLP_GRID_HALF_WIDTH_SE * se;
  const hi = thetaHat + KLP_GRID_HALF_WIDTH_SE * se;
  const step = (hi - lo) / (KLP_GRID_N - 1);
  let num = 0;
  let den = 0;
  for (let i = 0; i < KLP_GRID_N; i++) {
    const theta = lo + i * step;
    const z = (theta - thetaHat) / se;
    const w = Math.exp(-0.5 * z * z); // unnormalised Gaussian posterior weight
    num += w * fisherInformation(theta, b);
    den += w;
  }
  return num / den;
}

/**
 * 不确定性降权因子 ∈ (0,1)：precision 越高（θ̂ 越确定）越接近 1，
 * precision 越低（噪声大）越接近 0。√precision / (1+√precision) 单调饱和形态，
 * 给高不确定 θ̂ 的诊断价值降权（避免在噪声估计上浪费选题）。
 */
export function uncertaintyPenalty(thetaPrecision: number): number {
  const s = Math.sqrt(Math.max(thetaPrecision, 1e-9));
  return s / (1 + s);
}

/**
 * 诊断评分：MFI × 不确定性降权。高信息量 × 高确定性 → 高诊断价值。
 */
export function diagnosticScore(thetaHat: number, b: number, thetaPrecision: number): number {
  return mfiScore(thetaHat, b) * uncertaintyPenalty(thetaPrecision);
}

/**
 * Softmax 概率（温度可调）。temperature 越低越尖锐（趋近 argmax），越高越均匀。
 * 数值稳定：减最大值后再 exp。空输入返回空数组。
 *
 * 这是 Phase 3 随机化选题的 π_i（inclusion probability）来源：non-due 槽按
 * 评分 softmax 抽样，π_i 是 active-PPI 重标定（D17 推翻后）必需的慢热资产。
 *
 * Fail-fast 护栏（π_i 慢热资产不可被静默污染，同 recordSelectionObservation 哲学）：
 *   - temperature 必须 > 0：T≤0 会除零（→ 全 NaN π_i）或负温反转排序（抽到最差候选）。
 *   - score 必须有限：非有限 score 是上游 bug（θ̂/b 没兜底），fail-fast 而非
 *     产出全 NaN 的 π_i（单个 NaN 经 max/exp 会污染整批分布）。
 *   - 用 reduce 求 max，**不用 `Math.max(...scores)`**——超大候选集 spread 会爆栈。
 *
 * positivity 护栏（FINDING A，ADR-0043 §7）——**指数下溢清零是最深的 positivity 漏洞**：
 *   centered exponent `(s - max)/T` 恒 ≤ 0；当 score 跨度大时它会变成大负数，
 *   `Math.exp` 在指数 < log(Number.MIN_VALUE) ≈ -744.44 时**硬清零**（返回精确 0，
 *   非 denormal）。例：weights=[1000, 0]、T=0.25 ⇒ 低分项 exponent=(0-1000)/0.25=-4000
 *   ⇒ exp(-4000)=0 ⇒ q=0 ⇒ π_i=0 ⇒ 该候选永不被抽样、也永不进 IPW 资产（§7 positivity
 *   违例，active-PPI 估计偏置）。floor-fill 让每个权重 ≥ε 也救不了——下溢发生在 exp 之后。
 *
 *   修复：把 centered exponent **clamp 到 ≥ -CLAMP_K**（CLAMP_K=700）。exp(-700) ≈ 9.9e-305
 *   是**正规** double（远高于 MIN_NORMAL ≈ 2.2e-308），保证每个有限 score 的 q_i > 0。
 *   clamp 是单调非降映射 ⇒ 高 score → 高（或相等）q_i（单调性保全）；只在 score 跨度
 *   超过 CLAMP_K·T（=175 @T=0.25）的极端尾部把多个低分压平到同一极小正值（可接受：
 *   它们本就该是「近零」概率，clamp 只把「精确零」抬成「极小正」以保 positivity）。
 *   正常跨度（如 [1000,999]，跨度 1 ≪ 175）完全不触发 clamp，分布数值不变。
 */
const CLAMP_K = 700;

export function softmaxProbabilities(scores: number[], temperature = 0.25): number[] {
  if (scores.length === 0) return [];
  if (!(temperature > 0)) {
    throw new Error(`softmaxProbabilities: temperature must be > 0, got ${temperature}`);
  }
  let max = Number.NEGATIVE_INFINITY;
  for (const s of scores) {
    if (!Number.isFinite(s)) {
      throw new Error(`softmaxProbabilities: non-finite score ${s}`);
    }
    if (s > max) max = s;
  }
  // clamp 下溢防线（FINDING A）：centered exponent 不低于 -CLAMP_K ⇒ exp 永不清零 ⇒ q_i>0。
  const exps = scores.map((s) => Math.exp(Math.max(-CLAMP_K, (s - max) / temperature)));
  const total = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / total);
}
