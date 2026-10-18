/**
 * QA r4 真实留出题（PR #1740 comment 6243725363，head c1158779d，
 * opencode-go/mimo-v2.6-pro）的延迟和费用。准入循环是逐题串行的，墙钟等于
 * 各题耗时之和。
 *
 * 干跑：7.3 min = 438_000 ms，30/30 返回，90s 处 0 次截尾。
 * 正式跑：14.7 min = 882_000 ms，25 次返回，5 次在 90_000 ms 右截尾（全是
 * 导数题）。截尾占 450_000 ms，其余 25 题合计 432_000 ms（均值 17_280 ms）。
 * 干跑均值 14_600 ms。两次里已经跑完的工作几乎一样，14.7 和 7.3 的差就是
 * 那 5 次被掐断的等待，不是整次调用都变慢一倍。
 *
 * 跑完的调用全部 < 90s。5 次截尾只知道 ≥ 90s。用 17s 均值去拟合单指数分布
 * 对不上（那样 P(X>90s) 约 0.5%，实测是 5/30）。慢的是导数题这一支。
 *
 * 单次超时取截尾点的两倍。这 5 次在 90s 时仍在跑，截尾样本能确定的尺度只有
 * 这个截尾点：剩余时间的尺度按已经等掉的截尾点计（指数残差，不再另设形状
 * 参数），条件均值是 90s + 90s = 180s。跑完的调用上界 < 90s，落在这个默认
 * 值里。`task.AssessmentRubricJudgeTask.budget.timeout` 经 resolveTaskBudget
 * 覆盖它。
 *
 * 费用：55 次成功调用账本 $0.0447 = 44_700 µ$。超时没有成交价。重试闸门用
 * 这笔均价的向上取整当 estimated，不用当时 $0.02 的预留去冒充已知费用。
 * runner 的 transientRetries 不重试 budget_timeout，所以这一次重试在执行器里做。
 */

export const QA_R4_RUBRIC_LATENCY = {
  censorMs: 90_000,
  bindingWallMs: 882_000,
  bindingItems: 30,
  bindingCensored: 5,
  dryWallMs: 438_000,
  dryItems: 30,
} as const;

export const QA_R4_SUCCESSFUL_CALLS = 55;
export const QA_R4_SUCCESSFUL_COST_MICROS = 44_700;

/** 一次成功调用的估计价（µ$）。再留一次估计价仍不超过 cap 时才重试超时。 */
export const ASSESSMENT_RUBRIC_ESTIMATED_ATTEMPT_MICROS = Math.ceil(
  QA_R4_SUCCESSFUL_COST_MICROS / QA_R4_SUCCESSFUL_CALLS,
);

/** 超时后再试一次。非超时失败不走这条。 */
export const ASSESSMENT_RUBRIC_TIMEOUT_RETRIES = 1;

/**
 * 从截尾样本得出单次调用超时。已完成部分的变慢不超过 1.5 倍时，墙钟缺口
 * 就是截尾等待，条件均值用 2×截尾点。样本不再是这个形状时抛错，避免默默
 * 沿用一个对不上的数。
 */
export function assessmentRubricTimeoutFromCensoredHoldout(
  sample: typeof QA_R4_RUBRIC_LATENCY = QA_R4_RUBRIC_LATENCY,
): number {
  const uncensoredCount = sample.bindingItems - sample.bindingCensored;
  const uncensoredMass = sample.bindingWallMs - sample.bindingCensored * sample.censorMs;
  if (uncensoredCount <= 0 || uncensoredMass <= 0 || sample.dryItems <= 0) {
    throw new Error('censored holdout does not identify a completed-call mass');
  }
  const slowdown = uncensoredMass / uncensoredCount / (sample.dryWallMs / sample.dryItems);
  if (slowdown > 1.5) {
    throw new Error('completed-call slowdown is too large for the censor-residual derivation');
  }
  return sample.censorMs * 2;
}

/** 一次正式或准入调用的墙钟：单次超时，再加一次完整的超时重试窗口。 */
export function assessmentRubricInvocationWindowMs(timeoutMs: number): number {
  return timeoutMs * (1 + ASSESSMENT_RUBRIC_TIMEOUT_RETRIES);
}

/**
 * 一次超时之后还能否再付一次。knownSpent 是已经成交的 µ$；unknownAttempts
 * 含刚刚这次没有成交价的超时。下一次按估计价占用，加起来超过 cap 就不重试。
 */
export function assessmentRubricTimeoutRetryFits(
  knownSpent: number,
  unknownAttempts: number,
  cap: number,
): boolean {
  const held = knownSpent + (unknownAttempts + 1) * ASSESSMENT_RUBRIC_ESTIMATED_ATTEMPT_MICROS;
  return Number.isFinite(held) && held <= cap;
}
