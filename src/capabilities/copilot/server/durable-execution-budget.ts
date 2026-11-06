/**
 * Durable Copilot runs carry NO quantity ceilings — owner directive removes all
 * spend caps (agentic turns, tool calls, row budgets are uncapped; the Copilot
 * context-budget surface keeps advisory warnings only). What remains is the
 * wall-clock execution window, which exists for owner recovery, not cost:
 * `timeoutMs` doubles as the basis of DURABLE_OWNER_SETTLEMENT_BUDGET_MS in
 * copilot_run.ts, and it MUST stay finite and strictly below
 * STUCK_RUN_THRESHOLD_MS (1h) or the stuck-run sweeper would converge a live
 * execution. 45min leaves the sweeper a ~14.5min margin.
 *
 * Dependency-free leaf: the admin config facts seam projects these caller-owned
 * limits without importing the execution module (and its pi runtime chain).
 */
export const DURABLE_COPILOT_EXECUTION_BUDGET = {
  /** 'unbounded' maps to no `shouldStopAfterTurn` on the pi lane — turns are
   *  limited only by explicit Stop, cancellation, or the timeout below. */
  maxIterations: 'unbounded',
  timeoutMs: 45 * 60_000,
} as const;
