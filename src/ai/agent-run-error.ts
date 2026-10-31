// Failure taxonomy for single-attempt runner errors. Classification stays
// conservative: only evidence-frozen transient shapes are retried, because
// retrying an uncertain failure risks a double bill.
//
//   - API-level errors (4xx / 429 / 5xx / connection-class) arrive as
//     `SDKResultSuccess { is_error: true, api_error_status }` and are wrapped as
//     'api_error_result'.
//   - `api_error_status === null` marks a connection-class drop (mid-stream
//     socket loss); 429 / 5xx are transient by semantics.
//   - `error_during_execution` is permanent. Classic API statuses stay on
//     api_error_result; a bound pi 429/502 is the helpProviderFault exception
//     and is not retried.
//   - 'stream_no_terminal' is a process-level fast failure: the message stream
//     ended without a terminal result (engine death / stream drop).
//   - abort/timeout and anything unrecognized are permanent.

import type { HelpProviderFault } from '@/ai/help-provider-fault';

/** SDKResultError['subtype'] union. */
type SdkResultErrorSubtype =
  | 'error_during_execution'
  | 'error_max_turns'
  | 'error_max_budget_usd'
  | 'error_max_structured_output_retries';

export type AgentFailureSubtype =
  | SdkResultErrorSubtype
  /** success+is_error terminal; the only shape API errors take. */
  | 'api_error_result'
  /** Message stream ended without a terminal result (engine death / stream drop). */
  | 'stream_no_terminal'
  /** Lifecycle budget elapsed before a terminal result was observed. */
  | 'budget_timeout'
  /** Cross-process session lease/control-plane failure after durable start. */
  | 'provider_admission'
  /** Non-SDK exception after the attempt acquired a durable task-run id. */
  | 'runner_error'
  /**
   * Typed-endpoint contract violation after a transport-level success: non-JSON
   * body, response schema mismatch, or model/provider drift from the pinned
   * canonical. Permanent: retrying a deterministic violation only double-bills.
   */
  | 'typed_contract_violation';

/**
 * Retry gate: a transient failure is retried only when it arrives within this
 * window of the first attempt's start. Fixed (not a budget.timeout ratio), since
 * a ratio would silently widen sync-route wall-clock as budgets grow. The
 * opted-in judge's absolute provider-session deadline includes one full
 * budget.timeout on top, so admission wait and startup share the bound instead
 * of adding to it. The retry-start deadline never truncates an attempt that
 * already started.
 */
export const RETRY_ELAPSED_CAP_MS = 10_000;

export interface AgentRunErrorFields {
  kind: string;
  taskRunId: string;
  subtype: AgentFailureSubtype;
  /** Only for 'api_error_result'; null marks connection-class. */
  apiErrorStatus?: number | null;
  /** SDKResultError.errors, or [result error text] for api_error_result. */
  errors: string[];
  /** Known attempt cost; absent means unknown, not zero. */
  costUsd?: number;
  /** Quota, 502, or parse. Absent for every other failure, including HTTP 400. */
  helpProviderFault?: HelpProviderFault;
}

/**
 * Structured single-attempt failure. The message keeps a grep-able
 * `[kind] agent run errored: subtype=…` format; the structured fields preserve
 * the errors, API status and run id the string alone cannot carry.
 */
export class AgentRunError extends Error {
  readonly kind: string;
  readonly taskRunId: string;
  readonly subtype: AgentFailureSubtype;
  readonly apiErrorStatus?: number | null;
  readonly errors: string[];
  readonly costUsd?: number;
  readonly helpProviderFault?: HelpProviderFault;

  constructor(fields: AgentRunErrorFields) {
    const http =
      fields.subtype === 'api_error_result' ? ` http=${fields.apiErrorStatus ?? 'null'}` : '';
    const detail = fields.errors.length > 0 ? ` errors=${fields.errors.join('; ')}` : '';
    super(`[${fields.kind}] agent run errored: subtype=${fields.subtype}${http}${detail}`);
    this.name = 'AgentRunError';
    this.kind = fields.kind;
    this.taskRunId = fields.taskRunId;
    this.subtype = fields.subtype;
    this.apiErrorStatus = fields.apiErrorStatus;
    this.errors = fields.errors;
    this.costUsd = fields.costUsd;
    this.helpProviderFault = fields.helpProviderFault;
  }
}

/**
 * Thrown by run-lifecycle when the provider session wall-clock budget elapses.
 * Deliberately not an AgentRunError: the runner's `aborted` binding keys off
 * lifecycle state, and classification must treat this as a non-SDK failure.
 * Recognition is by identity, never by message, so a look-alike plain Error
 * cannot be downgraded to a degraded reply instead of failing closed.
 */
export const PROVIDER_SESSION_WALL_CLOCK_BUDGET_MESSAGE =
  'provider session wall-clock budget elapsed';

export class ProviderSessionWallClockBudgetError extends Error {
  constructor(phase: string) {
    super(`${PROVIDER_SESSION_WALL_CLOCK_BUDGET_MESSAGE} ${phase}`);
    this.name = 'ProviderSessionWallClockBudgetError';
  }
}

export function isProviderSessionWallClockBudgetError(error: unknown): boolean {
  return error instanceof ProviderSessionWallClockBudgetError;
}

/**
 * Whitelist-only transient predicate. Anything not an AgentRunError (budget
 * aborts, config errors, unknown throws) is permanent by default.
 */
export function isTransientAgentFailure(err: unknown): boolean {
  if (!(err instanceof AgentRunError)) return false;
  if (err.subtype === 'stream_no_terminal') return true;
  if (err.subtype === 'api_error_result') {
    const status = err.apiErrorStatus;
    if (status === null || status === undefined) return true; // connection-class
    if (status === 429) return true;
    if (status >= 500 && status <= 599) return true;
    return false; // other 4xx: auth/config/validation
  }
  return false; // error_during_execution / error_max_* / anything else
}
