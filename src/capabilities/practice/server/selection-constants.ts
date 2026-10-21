// Selection policy shape and constants. Pure: no IO or wiring.
//
// π_i must be a true sampling inclusion probability with positivity, never a deterministic
// top-item normalized after the fact. Sampler math lives in selection-sampler.ts.

/** Selection policy config carried into the async compose path. */
export interface SelectionPolicyConfig {
  policy: 'legacy' | 'softmax_mfi';
  /** tempered-softmax 温度 T>0；省略时用 DEFAULT_TEMPERATURE。 */
  temperature?: number;
  /** Poisson IPPS 的目标期望子集大小 Σπ_i；省略时由 shell 按容量传入。 */
  targetCount?: number;
}

/**
 * 默认选题策略 = 'softmax_mfi'（**owner 拍板 default-ON**，2026-06-16）。
 *
 * 实施计划「待 owner 决策」段（impl plan:40-44）列了 'legacy'（建议、安全）vs
 * 'softmax_mfi'（落地即生效）两选项；owner 选 default-ON——merge 即改变
 * 每日**非到期**题选择（到期项 presence + intra-day 序仍 L1 确定性，不动，档2 不取档3）。
 *
 * ⚠️ 这是整条选题线的第一个真行为变更：合并后 owner 每日看到的非到期题来自
 * LLM 权重 → sampler 抽样，而非 legacy 确定性 compose。两级 fallback（LLM 挂 →
 * 纯统计 sampler → 再挂退 composeDailyStream）由 Step C2 接线保兜底。
 */
export const DEFAULT_SELECTION_POLICY: SelectionPolicyConfig['policy'] = 'softmax_mfi';

/**
 * 默认 tempered-softmax 温度 T。与 `softmaxProbabilities` 的默认 0.25 对齐
 * （src/core/selection-signals.ts），避免两处默认漂移。
 *
 * 温度旋钮（唯一 tunable trade-off，:60）：
 * T 越低 = LLM 越主导 = q_i 越尖 = π_i 越尖 = 后期 active-PPI的
 * IPW/Horvitz-Thompson 方差越大；T 越高 = 越均匀 = π_i 越平 = IPW 方差越小但
 * LLM 编排意图被抹平。recalibration deferred + PPI++ power-tuning 自降级兜底。
 */
export const DEFAULT_TEMPERATURE = 0.25;

/**
 * B3 mem0 learner-prior 最多注入 5 条（H5 /）。默认/粒度：每次
 * L2 orchestration 5 条；观测：prompt 中 FACT 行数；护栏：hard（超过即截断）。
 */
export const MEM0_PRIOR_CAP = 5;

/**
 * 单条 mem0 learner-prior 的字符上限。默认/粒度：每条 240 chars；观测：prompt 中
 * 单条 FACT 长度；护栏：hard（换行压平后截断）。
 */
export const MEM0_PRIOR_ITEM_CHAR_CAP = 240;

/**
 * 完整 `<ADVISORY_ONLY>` 块的字符上限（含标签与 DATA_ONLY 声明）。默认/粒度：每次
 * L2 orchestration 1,200 chars；观测：memoryPrior 字段长度；护栏：hard（二层截断）。
 */
export const MEM0_PRIOR_BLOCK_CHAR_CAP = 1_200;

/**
 * SelectionOrchestratorTask candidate prompt cap. Candidates are deterministically preselected by
 * diagnostic score (falling back to MFI), so L2 prompt size stays bounded without changing the
 * complete statistical sampling pool or its positivity guarantees.
 */
export const SELECTION_ORCHESTRATOR_CANDIDATE_CAP = 24;

/**
 * P2 D2 / A8 — dark-ship flag for the `misconceptionRecurrence` selection signal
 * (candidate-signals.ts batchAggregateMisconceptionRecurrence).
 *
 * false (DEFAULT) → misconceptionRecurrence stays `undefined` for every candidate → the
 * aggregate query is never issued → buildSelectionOrchestratorInput emits
 * `misconception_recurrence=n/a` for all (byte-identical orchestrator prompt to today)
 * and the mfiScore / diagnosticScore path is untouched.
 * true → the 0-1 normalized per-learner cross-attempt cause-family recurrence is computed
 * and surfaced (SELECTION-ONLY: it feeds only the orchestrator prompt, never θ̂/p(L)/FSRS).
 *
 * Lives here (a pure, IO-free dependency module) — NOT inline in candidate-signals.ts — so
 * tests can mock just this one export via `vi.mock(... importOriginal)` exactly like the
 * EARLY_KLP_ENABLED pattern, keeping both flag directions covered regardless of the default.
 * Flip to true is a separate owner go-live decision, gated by the fresh correctness, latency,
 * judge-health, cause-label calibration, and rollback evidence in
 *
 */
export const MISCONCEPTION_RECURRENCE_ENABLED = false;
