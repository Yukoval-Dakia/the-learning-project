// YUK-576 — structured failure carrier + transient/permanent classifier for the
// runner's single-attempt failures.
//
// The classification table is EVIDENCE-FROZEN (design doc §2.3, probes run
// 2026-07-07 against CLI 2.1.168 / SDK 0.3.168 — see runner.fallback.test.ts
// fixture provenance):
//   - API-level errors (4xx / 429 / 5xx / connection-class) ALL terminate as
//     `SDKResultSuccess { is_error: true, api_error_status: number | null }` —
//     they NEVER surface as SDKResultError. The runner wraps that shape (on
//     opt-in paths only, see runner.ts) as subtype 'api_error_result'.
//   - `api_error_status === null` is the connection-class marker (mid-stream
//     socket drop; observed terminal in ~1.5s — the canonical fast transient).
//   - 429 / 5xx are transient by semantics; empirically they arrive only after
//     the CLI's internal api_retry ×10 exponential backoff (~3min), so for
//     short-budget tasks the budget abort (permanent) or the elapsed gate
//     independently blocks them — the rows are kept for honesty + future
//     long-budget opt-ins.
//   - `error_during_execution` is PERMANENT (conservative default): probes
//     proved API failures never land there; it presumably carries CLI-internal
//     execution errors. `errors[]` is preserved into error_message for future
//     recalibration.
//   - 'stream_no_terminal': the SDK message stream ended without a terminal
//     result message (CLI death / stream drop) — transient, process-level fast
//     failure. Previously this was silently recorded as a SUCCESS run.
//   - abort/timeout and everything unrecognized: permanent (whitelist-only
//     retries — never retry an uncertain failure into a double bill).

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/** SDKResultError['subtype'] union, spelled out (sdk.d.ts:3538-3556). */
type SdkResultErrorSubtype =
  | 'error_during_execution'
  | 'error_max_turns'
  | 'error_max_budget_usd'
  | 'error_max_structured_output_retries';

export type AgentFailureSubtype =
  | SdkResultErrorSubtype
  /** success+is_error terminal (the ONLY shape API errors take — probe-frozen). */
  | 'api_error_result'
  /** SDK stream ended without a terminal result message. */
  | 'stream_no_terminal';

/**
 * R1 (YUK-576 review) — the sixth retry gate: a transient failure is only
 * retried when it arrived within this window from the FIRST attempt's start.
 * Fixed constant (NOT a budget.timeout ratio): a ratio would silently widen the
 * sync-route wall-clock as budgets grow — exactly the failure mode the gate
 * exists to block. Worst-case wall clock for the opted-in judges =
 * cap + one full budget.timeout = 10s + 90s = 100s, aligned with the
 * cloudflared edge idle-disconnect bound (design doc §3.4).
 */
export const RETRY_ELAPSED_CAP_MS = 10_000;

export interface AgentRunErrorFields {
  kind: string;
  taskRunId: string;
  subtype: AgentFailureSubtype;
  /** Only for 'api_error_result'; null = connection-class (probe-frozen marker). */
  apiErrorStatus?: number | null;
  /** SDKResultError.errors, or [result error text] for api_error_result. */
  errors: string[];
}

/**
 * Structured single-attempt failure. The message keeps the legacy grep-able
 * `[kind] Agent SDK errored: subtype=…` format (existing `.rejects.toThrow`
 * assertions keep matching); the structured fields carry what the string
 * used to drop (errors[], api status, the attempt's run id).
 */
export class AgentRunError extends Error {
  readonly kind: string;
  readonly taskRunId: string;
  readonly subtype: AgentFailureSubtype;
  readonly apiErrorStatus?: number | null;
  readonly errors: string[];

  constructor(fields: AgentRunErrorFields) {
    const http =
      fields.subtype === 'api_error_result' ? ` http=${fields.apiErrorStatus ?? 'null'}` : '';
    const detail = fields.errors.length > 0 ? ` errors=${fields.errors.join('; ')}` : '';
    super(`[${fields.kind}] Agent SDK errored: subtype=${fields.subtype}${http}${detail}`);
    this.name = 'AgentRunError';
    this.kind = fields.kind;
    this.taskRunId = fields.taskRunId;
    this.subtype = fields.subtype;
    this.apiErrorStatus = fields.apiErrorStatus;
    this.errors = fields.errors;
  }
}

/**
 * Evidence-frozen transient predicate (design doc §2.3). Whitelist-only:
 * anything not an AgentRunError (budget aborts, config errors, unknown throws)
 * is permanent by default.
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

/**
 * Narrow helper for the runner: does this terminal result message carry the
 * success+is_error API-error shape? (Extracted so both the opt-in failure
 * wrap and the non-opt-in breadcrumb read one predicate.)
 */
export function isApiErrorSuccessResult(
  msg: Extract<SDKMessage, { type: 'result' }>,
): msg is Extract<SDKMessage, { type: 'result'; subtype: 'success' }> & {
  is_error: true;
  api_error_status?: number | null;
} {
  return msg.subtype === 'success' && 'is_error' in msg && msg.is_error === true;
}
