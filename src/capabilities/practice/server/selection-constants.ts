// YUK-361 Phase 3 Step C1 — 选题策略常量 + policy config（PURE，无 IO，无接线）。
//
// 权威：ADR-0042 编排档2 amendment（docs/adr/0042-...md:46-68）+ ADR-0043 §7
// （π_i 必须是真随机抽样的 inclusion probability，满足 positivity，非确定性
// top-item 事后归一化）+ docs/superpowers/plans/2026-06-16-phase3-randomized-mfi-impl.md Step C。
//
// 这里只声明 policy 形状 + 默认值 + 温度旋钮常量；sampler 数学在 selection-sampler.ts。
// 接线进 shell（stream-store getStream/recompose）是 Step C2，本步不动。

/**
 * 选题策略配置。线程进 shell 的 async 选题路径（参既有 `capacity?` 传法）。
 *
 * - `policy: 'legacy'`  → 走确定性 `composeDailyStream`（stream-composer.ts，7 单测保绿）。
 * - `policy: 'softmax_mfi'` → 走档2 LLM-strong 路径：L2 LLM 出权重 → tempered-softmax
 *   sampler 抽样落题 + 记真 π_i（喂 Phase 6 active-PPI IPW/Horvitz-Thompson）。
 */
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
 * 'softmax_mfi'（落地即生效）两选项；owner 选 default-ON——Phase 3 merge 即改变
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
 * 温度旋钮（唯一 tunable trade-off，ADR-0042:60）：
 *   T 越低 = LLM 越主导 = q_i 越尖 = π_i 越尖 = 后期 active-PPI（Phase 6）的
 *   IPW/Horvitz-Thompson 方差越大；T 越高 = 越均匀 = π_i 越平 = IPW 方差越小但
 *   LLM 编排意图被抹平。recalibration deferred + PPI++ power-tuning 自降级兜底。
 */
export const DEFAULT_TEMPERATURE = 0.25;

/**
 * P2 D2 / A8 — dark-ship flag for the `misconceptionRecurrence` selection signal
 * (candidate-signals.ts aggregateMisconceptionRecurrence).
 *
 * false (DEFAULT) → misconceptionRecurrence stays `undefined` for every candidate → the
 *   aggregate query is never issued → buildSelectionOrchestratorInput emits
 *   `misconception_recurrence=n/a` for all (byte-identical orchestrator prompt to today)
 *   and the mfiScore / diagnosticScore path is untouched.
 * true → the 0-1 normalized per-learner cross-attempt cause-family recurrence is computed
 *   and surfaced (SELECTION-ONLY: it feeds only the orchestrator prompt, never θ̂/p(L)/FSRS).
 *
 * Lives here (a pure, IO-free dependency module) — NOT inline in candidate-signals.ts — so
 * tests can mock just this one export via `vi.mock(... importOriginal)` exactly like the
 * EARLY_KLP_ENABLED pattern, keeping both flag directions covered regardless of the default.
 * Flip to true is an owner go-live decision.
 */
export const MISCONCEPTION_RECURRENCE_ENABLED = false;
