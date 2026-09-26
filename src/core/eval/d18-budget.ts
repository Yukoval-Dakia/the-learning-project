// ====================================================================
// YUK-1057 — D18 独立评测预算 gate（decisions D18；≤$5 / ≤200 核验调用 /
// ≤800 requests / per-call caps / 首次触顶即停）
// ====================================================================
//
// 纯函数、零 IO。caller 侧 fail-closed：harness 在【发起模型调用之前】
// 必须先过 admit()；触顶（BudgetHaltError）后所有后续 admit 一律拒绝 ——
// 门闩 latch 不可复位（构造新实例才可重开一轮评测，「触顶即停」
// 不做静默 resume）。
//
// D18 决策原文（docs/planning/2026-09-24-question-assessment-decisions.md）：
//   - 独立评测预算上限 $5（与 $0.01 smoke 分开）。
//   - 覆盖 dev/holdout 样本、Jev escalation、最多 200 次独立核验调用；
//     所有 retries 计入。
//   - 总预算内最多 800 次 model requests，并设 per-call input/output caps；
//     首次触顶即停。
//   - 未知成本按保守值预留。
//
// 「核验调用」（verification calls）= 判分/核验语料的模型调用，与目录
// 探测/重试调用分开计数；一切 call kind 都计入 requests 总量。

/** 预算天花板（D18 裁决值；构造可覆盖用于合成超预算驱动测试）。 */
export interface EvalBudgetCaps {
  /** 总成本上限（USD）。D18 = 5.00。 */
  totalCostUsd: number;
  /** 独立核验调用上限（所有 retries 计入）。D18 = 200。 */
  maxVerificationCalls: number;
  /** 全部 model requests 上限（含 retries / 非核验调用）。D18 = 800。 */
  maxRequests: number;
  /** 单 call 输入 token 上限。 */
  perCallInputTokens: number;
  /** 单 call 输出 token 上限。 */
  perCallOutputTokens: number;
  /** 每次调用额外预留（未知成本按保守值预留：从 ceiling 减去后才给 admit）。 */
  reserveUsd: number;
}

export const D18_BUDGET_CAPS: EvalBudgetCaps = {
  totalCostUsd: 5.0,
  maxVerificationCalls: 200,
  maxRequests: 800,
  perCallInputTokens: 32_000,
  perCallOutputTokens: 8_192,
  // 未知成本保守预留：OpenRouter Jev 实测单次 $1.5e-5（D12 smoke），
  // MiMo text/vision 单次按官方价表也不会超过 $0.01 —— reserve 取 $0.02，
  // 保证 [spent + estimated + reserve] ≤ $5 时 admit 仍留实际余量。
  reserveUsd: 0.02,
};

export type EvalCallKind =
  /** dev/holdout 语料的判分/核验调用（计入 verification 上限）。 */
  | 'verification'
  /** 其余一切 model request（escalation、重试、预热等）。 */
  | 'auxiliary';

export interface EvalCallEstimate {
  kind: EvalCallKind;
  /** 预计输入 tokens（调用方按实际 prompt 计算，未知时取保守上界）。 */
  inputTokens: number;
  /** 预计输出 tokens（max_tokens / 保守上界）。 */
  outputTokens: number;
  /** 预计成本（USD）；未知 → null 走 reserve 保守路径。 */
  estimatedCostUsd: number | null;
}

export type EvalBudgetRejectReason =
  | 'per_call_input_exceeded'
  | 'per_call_output_exceeded'
  | 'verification_ceiling'
  | 'request_ceiling'
  | 'cost_ceiling'
  | 'halted';

export class BudgetHaltError extends Error {
  readonly reason: EvalBudgetRejectReason;
  constructor(reason: EvalBudgetRejectReason, detail: string) {
    super(`D18 budget gate halt (${reason}): ${detail}`);
    this.name = 'BudgetHaltError';
    this.reason = reason;
  }
}

export interface EvalBudgetLedger {
  spentUsd: number;
  requests: number;
  verificationCalls: number;
  halted: boolean;
  haltReason: EvalBudgetRejectReason | null;
}

/**
 * 预算 gate（caller 侧 fail-closed）。
 *
 * 生命周期：
 *   1. 每次调用前 admit() —— 任何违反 ceiling/per-call cap 立即抛
 *      BudgetHaltError 并【永久 latch】本实例；
 *   2. 调用返回后 settle() —— 记账实际 tokens/cost（retries 各自 settle，
 *      即 retries 也计入 verification/request 计数：admit 时就已计一次）。
 * settle 不抛 —— 已发生的调用如实入账；超额在下一次 admit 触顶即停。
 */
export class EvalBudgetGate {
  private readonly caps: EvalBudgetCaps;
  private spentUsd = 0;
  private requests = 0;
  private verificationCalls = 0;
  private haltReason: EvalBudgetRejectReason | null = null;

  constructor(caps: EvalBudgetCaps = D18_BUDGET_CAPS) {
    this.caps = caps;
  }

  /** 当前账本快照（报告工件/日志用）。 */
  ledger(): EvalBudgetLedger {
    return {
      spentUsd: this.spentUsd,
      requests: this.requests,
      verificationCalls: this.verificationCalls,
      halted: this.haltReason !== null,
      haltReason: this.haltReason,
    };
  }

  /** latch 便捷判断（harness 循环的早停条件）。 */
  get halted(): boolean {
    return this.haltReason !== null;
  }

  private halt(reason: EvalBudgetRejectReason, detail: string): never {
    // latch：首个触发原因保留 —— 后续 halt('halted') 不覆盖证据链。
    if (this.haltReason === null) {
      this.haltReason = reason;
    }
    throw new BudgetHaltError(reason, detail);
  }

  /**
   * 调用前许可。违反任何 ceiling/cap → BudgetHaltError（latch）。
   * 通过即【预付】计入 requests/verificationCalls —— retries 属于新一轮
   * admit，重试同样计入（D18：所有 retries 计入）。
   */
  admit(call: EvalCallEstimate): void {
    if (this.haltReason !== null) {
      this.halt(
        'halted',
        `gate already halted by ${this.haltReason} — 触顶即停，不继续发起任何调用`,
      );
    }
    if (call.inputTokens > this.caps.perCallInputTokens) {
      this.halt(
        'per_call_input_exceeded',
        `estimated input ${call.inputTokens} > per-call cap ${this.caps.perCallInputTokens}`,
      );
    }
    if (call.outputTokens > this.caps.perCallOutputTokens) {
      this.halt(
        'per_call_output_exceeded',
        `estimated output ${call.outputTokens} > per-call cap ${this.caps.perCallOutputTokens}`,
      );
    }
    if (
      call.kind === 'verification' &&
      this.verificationCalls + 1 > this.caps.maxVerificationCalls
    ) {
      this.halt(
        'verification_ceiling',
        `verification call #${this.verificationCalls + 1} would exceed ${this.caps.maxVerificationCalls}`,
      );
    }
    if (this.requests + 1 > this.caps.maxRequests) {
      this.halt(
        'request_ceiling',
        `request #${this.requests + 1} would exceed ${this.caps.maxRequests}`,
      );
    }
    // 未知成本按保守值预留：unknown estimate → 用 max(per-call 既有观测上界,
    // reserveUsd) 记账；admit 判据 = spent + est + reserve ≤ cap。
    const estimated = call.estimatedCostUsd ?? this.caps.reserveUsd;
    if (this.spentUsd + estimated + this.caps.reserveUsd > this.caps.totalCostUsd) {
      this.halt(
        'cost_ceiling',
        `projected ${(this.spentUsd + estimated + this.caps.reserveUsd).toFixed(6)}USD ` +
          `(spent ${this.spentUsd.toFixed(6)} + est ${estimated.toFixed(6)} + reserve ${this.caps.reserveUsd.toFixed(6)}) ` +
          `would exceed ${this.caps.totalCostUsd.toFixed(2)}USD`,
      );
    }
    this.requests += 1;
    if (call.kind === 'verification') this.verificationCalls += 1;
  }

  /**
   * 调后入账。actualCostUsd 未知 → 按保守值（admit 时的 estimated 或 reserve）
   * 记入，绝不写 0 —— 「按保守值预留」的完整闭换：admit 预留 + settle 如数入。
   */
  settle(actual: {
    kind: EvalCallKind;
    inputTokens: number;
    outputTokens: number;
    actualCostUsd: number | null;
    estimatedCostUsd?: number | null;
  }): void {
    const cost = actual.actualCostUsd ?? actual.estimatedCostUsd ?? this.caps.reserveUsd;
    this.spentUsd += cost;
  }
}
