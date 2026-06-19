// B1 four-engine soft-track, increment 1 (YUK-348, ADR-0035 决定 #3 + 决定 #4 红线)
// — TS-native BKT (Bayesian Knowledge Tracing) forward estimator. PURE (no IO).
//
// ─── 这是什么（决定 #3「照字面全实例化四引擎」的 KT 引擎）──────────────────────
// owner 2026-06-14 拍板「照字面全实例化 IRT/CDM/KT/LLM 四个诊断引擎」（总账 §1 B1 第 42
// 行，ADR-0035 决定 #3）。本模块是其中的 **KT 引擎**：经典 BKT（Corbett & Anderson 1995）
// 的单技能 HMM forward 递推——给定一条 0/1 作答序列 + 固定先验四参数，逐步贝叶斯更新
// 掌握后验 p(L_t)，返回 { pL0, pT, pS, pG, pLFinal, n }。
//
// 四参数（Corbett & Anderson 1995，B1 foundation §4 第 102 行逐字核到）：
//   - p(L0) = 先验掌握概率（作答前已掌握该 KC 的概率）。
//   - p(T)  = 学习率（一次作答机会上「未掌握 → 掌握」的跃迁概率）。
//   - p(S)  = slip（已掌握却答错的概率）。
//   - p(G)  = guess（未掌握却蒙对的概率）。
//
// ─── 红线（决定 #4，不可被决定 #3 软化）：实例化 ≠ 可信 ────────────────────────
// 本引擎的输出钉**软轨低置信**：写进 item_calibration.kt_json 作**纯持久化 sink**，
// **绝不**喂 p(L) / 调度 / 显示 / 硬轨自校验（PFA 是唯一可信决策信号，ADR-0035 决定 #4）。
// 在 n=1（owner 一人、每 KC 稀疏作答、无 cohort）下，p(S)/p(G) 是**结构性不可估**的——
// HMM 的 slip 与 guess 高度耦合（同一次错误既可解释为「未掌握」也可解释为「slip」），
// 解耦需「同一 KC 一条足够长、有起伏的作答序列」，正是 n=1 最稀缺的（往往个位数次作答）；
// 这撞 IRT 的 a/c 同一道墙（承重证据 = Stocking 1990，Psychometrika Q1；BKT slip/guess 同源
// 是机制推断，B1 foundation §3 第 145 行 + 表 M1/M2 诚实分界）。
//
// 故本估计器**只跑 forward 递推、用固定先验四参数**，**不**做 EM / MLE 拟合 p(T)/p(S)/p(G)
// （n=1 拟合多原样回吐先验、零信息增量，B1 foundation §6.2 第 262 行）。n=1 下输出多为
// **prior-echo**（先验回吐）——这是**预期且正确**的：本增量的价值是「管线先就位 + 扩多用户
// 期权 + 诊断丰富度」（ADR-0035 决定 #3 四条理由），**不是**可信参数。空/极短序列直接原样
// 回吐先验（never fabricates info at n=1，下方 estimateBkt 的 n===0 早返 + 红线单测）。

/**
 * 固定先验四参数（PHASE-DEFERRED：n=1 prior-echo）。
 *
 * 这些是**写死的先验**，不是从数据估出来的——在 n=1（无 cohort）下 p(S)/p(G) 结构性不可估
 * （Stocking 1990 摘要逐字：能力无散布 → 区分度/slip/guess 不可识别；BKT 版同源死路，
 * B1 foundation §3 表第 145 行机制推断）。forward 递推只**消费**这些先验、贝叶斯更新隐状态
 * 后验 p(L_t)，**绝不**反过来拟合它们（那需要同一 KC 的长起伏序列，n=1 凑不出）。
 *
 * 取值是文献常见的 BKT 默认先验（Corbett & Anderson 1995 量级），保守起步、owner 可调：
 *   - DEFAULT_P_L0 = 0.2  先验掌握偏低（冷启假设多数 KC 未掌握）。
 *   - DEFAULT_P_T  = 0.1  每次机会的学习跃迁率。
 *   - DEFAULT_P_S  = 0.1  slip 下限（已掌握偶尔手滑）。
 *   - DEFAULT_P_G  = 0.2  guess 上限（未掌握偶尔蒙对，与典型 4-5 选项题量级一致）。
 *
 * 何时完善 / 去哪查上下文：B1 Wave2 软轨估计器接通（扩多用户后 p(S)/p(G) 才结构性可估，
 * 那时才可能用真数据 firm-up）；在此之前这些**恒为占位先验**，输出钉软轨低置信不喂决策
 * （ADR-0035 决定 #4）。详见 docs/adr/0035-...md 决定 #3/#4 +
 * docs/design/2026-06-14-b1-diagnostic-engines-foundation.md §3 / §4.3 / §6.2。
 */
export const DEFAULT_P_L0 = 0.2;
export const DEFAULT_P_T = 0.1;
export const DEFAULT_P_S = 0.1;
export const DEFAULT_P_G = 0.2;

/** BKT 先验四参数（固定先验；forward 只消费不拟合，见模块文档 + DEFAULT_* 注释）。 */
export interface BktPrior {
  /** p(L0) — 先验掌握概率。 */
  pL0: number;
  /** p(T) — 学习率（未掌握→掌握跃迁概率）。 */
  pT: number;
  /** p(S) — slip（掌握却答错）。 */
  pS: number;
  /** p(G) — guess（未掌握却蒙对）。 */
  pG: number;
}

/** 固定先验默认值（命名常量，PHASE-DEFERRED 见 DEFAULT_* 注释）。 */
export const DEFAULT_BKT_PRIOR: BktPrior = {
  pL0: DEFAULT_P_L0,
  pT: DEFAULT_P_T,
  pS: DEFAULT_P_S,
  pG: DEFAULT_P_G,
};

/**
 * BKT forward 估计结果。**钉软轨低置信**（ADR-0035 决定 #4）：写进 kt_json 作纯持久化 sink，
 * 绝不喂 p(L)/调度/显示。pS/pG/pT/pL0 是**原样回吐的先验**（n=1 结构性不可估，prior-echo）；
 * pLFinal 是 forward 递推后的掌握后验（这一项随序列动，但仍只作软轨诊断，不喂决策）。
 */
export interface BktEstimate {
  /** p(L0) — 回吐的先验掌握概率（prior-echo）。 */
  pL0: number;
  /** p(T) — 回吐的学习率（prior-echo）。 */
  pT: number;
  /** p(S) — 回吐的 slip（n=1 结构性不可估，prior-echo）。 */
  pS: number;
  /** p(G) — 回吐的 guess（n=1 结构性不可估，prior-echo）。 */
  pG: number;
  /** forward 递推后的掌握后验 p(L_n)。空序列 → = pL0（原样回吐先验）。 */
  pLFinal: number;
  /** 折进 forward 的作答数（= outcomeSeq.length）。 */
  n: number;
}

function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

/**
 * BKT 单技能 HMM forward 递推（Corbett & Anderson 1995 标准形）。**纯函数**（无 IO）。
 *
 * 给定一条 0/1 作答序列 `outcomeSeq`（1=对、0=错，按时间顺序）+ 固定先验四参数，逐步：
 *   1) **观测更新**（贝叶斯条件化在第 t 次作答上）——
 *      - 答对：p(L_t-1 | correct) = pL·(1−pS) / [ pL·(1−pS) + (1−pL)·pG ]
 *      - 答错：p(L_t-1 | wrong)   = pL·pS     / [ pL·pS     + (1−pL)·(1−pG) ]
 *   2) **学习转移**（这次作答机会上未掌握的可能跃迁到掌握）——
 *      p(L_t) = p(L_t-1 | obs) + (1 − p(L_t-1 | obs))·pT
 * 起点 p(L_0) = pL0（先验）。最终返回 pLFinal = p(L_n)。
 *
 * RED LINE（never fabricates info at n=1）：**空序列（n=0）原样回吐先验** —— pLFinal = pL0，
 * 四参数原值返回（无任何观测 → 无信息增量，绝不编造）。极短序列同理只折进它真有的那几次
 * 作答（不补、不外推）。这是 prior-echo 红线的实现锚点（kt-estimator.test.ts 验收）。
 *
 * 不拟合 pT/pS/pG（n=1 结构性不可估，见模块文档）——本函数只**消费**先验做 forward，绝不
 * 反推它们。
 */
export function estimateBkt(
  outcomeSeq: ReadonlyArray<0 | 1>,
  prior: BktPrior = DEFAULT_BKT_PRIOR,
): BktEstimate {
  const pL0 = clamp01(prior.pL0);
  const pT = clamp01(prior.pT);
  const pS = clamp01(prior.pS);
  const pG = clamp01(prior.pG);
  const n = outcomeSeq.length;

  // 空序列 → 原样回吐先验（RED LINE：n=0 无信息，pLFinal = pL0，绝不编造）。
  let pL = pL0;
  for (let t = 0; t < n; t++) {
    const correct = outcomeSeq[t] === 1;
    // 1) 观测条件化（贝叶斯后验，给定第 t 次作答结果）。
    const numerator = correct ? pL * (1 - pS) : pL * pS;
    const denominator = correct ? pL * (1 - pS) + (1 - pL) * pG : pL * pS + (1 - pL) * (1 - pG);
    // 退化保护：denominator≈0（病态先验，如 pS=pG=0 且观测矛盾）→ 保持 pL 不更新，
    // 不引入 NaN（软轨诊断鲁棒优先于数值精度；本就不喂决策）。
    const pLGivenObs = denominator > 0 ? numerator / denominator : pL;
    // 2) 学习转移（未掌握部分按 pT 跃迁到掌握）。
    pL = pLGivenObs + (1 - pLGivenObs) * pT;
  }

  return {
    pL0,
    pT,
    pS,
    pG,
    pLFinal: clamp01(pL),
    n,
  };
}
