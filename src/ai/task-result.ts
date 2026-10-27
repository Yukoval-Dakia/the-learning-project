import type { TaskTimeoutSource } from '@/ai/task-budget';

export interface TaskTextResult {
  text: string;
  task_run_id?: string;
  /** Provider stop reason. `max_tokens` / `length` means the text was cut off. */
  finishReason?: string;
  /** Known USD amount; absent when this attempt has no trustworthy price. */
  cost_usd?: number;
  /** Evidence class and immutable reference for cost_usd. */
  cost_basis?: 'reported' | 'estimated' | 'unknown';
  cost_ref?: string;
  /**
   * YUK-299 seam: structured-output passthrough. `RunTaskResult` is a structural
   * superset, so a TaskTextRunFn can read it. undefined ⇒ fall back to text parsing.
   * YUK-1537: the runner does not interpret the product; the capability validates
   * it before any domain publication.
   */
  structured_output?: unknown;
  /** NoteGenerateTask model phases; the job adds parse and DB timings. */
  phases?: NoteGeneratePhaseTimings;
}

type RequiredRunFacts = 'task_run_id' | 'finishReason' | 'cost_basis' | 'cost_ref';

export interface RunTaskResult
  extends Omit<TaskTextResult, RequiredRunFacts>,
    Required<Pick<TaskTextResult, RequiredRunFacts>> {
  usage: AiTaskUsage;
}

export interface LifecycleResult extends Omit<RunTaskResult, 'phases'> {}

/** Millisecond phase timings for one long-note generation. Absent on other tasks. */
export interface NoteGeneratePhaseTimings {
  prompt_build_ms?: number;
  /** Null when the provider sent no token before the call ended. */
  model_ttft_ms?: number | null;
  model_total_ms?: number;
  stream_ms?: number;
  parse_ms?: number;
  validation_ms?: number;
  retry_count?: number;
  db_write_ms?: number;
}

export interface AiTaskUsage {
  inputTokens: number;
  outputTokens: number;
  /**
   * YUK-1557 — provider prompt-cache counters, written on every terminal row (0 when
   * the lane reported no cache) so cache share never reads absence as unknown.
   */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** YUK-1557 — completed assistant turns (provider `num_turns`, or observed frames). */
  numTurns?: number;
  /**
   * `estimated` when a budget abort had to infer tokens from the prompt and
   * any streamed text. Absent when the provider reported the counts.
   */
  usage_basis?: 'reported' | 'estimated';
  phases?: NoteGeneratePhaseTimings;
  /** Metadata-only proof that the provider returned reasoning blocks; raw CoT is never persisted. */
  thinkingBlocks?: number;
  thinkingCharacters?: number;
  /** Bounded native context metadata, separate from billable token usage; no transcript or summary. */
  compaction?: {
    count: number;
    last: { trigger: 'manual' | 'auto'; preTokens: number; postTokens?: number };
  };
  /**
   * YUK-1630 — per-attempt transport evidence: timeout budget receipt plus wire
   * milestones. Metadata only — it never feeds token counts or cost truth.
   */
  transport?: ProviderTransportEvidence;
}

/** The one semantic cost truth owned by a central-runner model attempt. */
export type AttemptCostTruth =
  | { basis: 'reported'; amountUsd: number; ref: string }
  | { basis: 'estimated'; amountUsd: number; ref: string }
  | { basis: 'unknown'; amountUsd: null; ref: string };

export type AttemptCostBasis = AttemptCostTruth['basis'];

export type TransportLane = 'undici_agent' | 'observer_fetch';
export type RequestSendState =
  | 'not_sent'
  | 'sent_without_response'
  | 'response_received'
  | 'unknown'
  /** `in_flight` = the snapshot was taken while the request was still pending. */
  | 'in_flight';
export type TransportSendState = Exclude<RequestSendState, 'in_flight'>;
export type TransportTimeoutLayer =
  | 'connect'
  | 'headers'
  | 'body'
  /**
   * The SDK whole-request timer. Reserved — never emitted today: the SDK
   * wraps its abort into an SDK error type OUTSIDE fetch, so an
   * unattributed signal abort stays unclassified rather than being guessed
   * as the SDK layer.
   */
  | 'sdk'
  /**
   * Positive timeout evidence: an observed composed-AbortSignal abort that
   * `abort_initiators` attributes to the armed execution timer or the
   * caller's session deadline. Any other abort is not a timeout layer.
   */
  | 'signal';

/**
 * Which layer actually initiated an abort, recorded synchronously at the
 * initiator (never inferred from elapsed time or configured values).
 */
export type TransportAbortInitiator =
  /** The armed lifecycle execution timer — min(task budget, deadline). */
  | 'execution_timeout'
  /** The caller's absolute provider-session deadline elapsed. */
  | 'session_deadline'
  /** The caller-supplied `config.signal` fired. */
  | 'caller_signal'
  /** Provider-session lease fencing revoked the attempt. */
  | 'lease_lost'
  /** `lifecycle.abort()` — caller cancel / generic teardown abort. */
  | 'lifecycle_abort';

export interface TransportFailureEvidence {
  readonly name: string;
  readonly code?: string | number;
  /** Sanitized (secrets + auth patterns) and UTF-8 truncated. */
  readonly message: string;
  readonly cause?: readonly TransportFailureEvidence[];
}

export interface TransportAbortMarker {
  readonly at: string;
  readonly kind: TransportAbortInitiator;
}

export interface ProviderRequestEvidence {
  readonly seq: number;
  /**
   * Which transport actually carried this call — present once decided (the
   * dispatcher saw it → undici_agent; settled/ended without dispatch →
   * observer_fetch). Omitted while still undecided in flight.
   */
  readonly lane?: TransportLane;
  /**
   * Which DispatchHandler interface the fetch implementation passed — Node's
   * builtin undici 7 fetch hands the legacy surface, npm undici 8 hands the
   * modern one. Proves which bridge ran; absent when nothing dispatched.
   */
  readonly handler_api?: 'modern' | 'legacy';
  readonly fetch_invoked_at: string;
  /** onRequestStart — the request began executing on a socket. */
  readonly request_started_at?: string;
  /** onRequestSent — the full request (headers+body) reached the socket. */
  readonly request_sent_at?: string;
  /** onResponseStarted — the peer's response began arriving. */
  readonly response_started_at?: string;
  /** onResponseStart — status code observed. */
  readonly response_headers_at?: string;
  /** onResponseEnd/onResponseError — the request lifecycle settled on the wire. */
  readonly ended_at?: string;
  /** The fetch promise itself resolved/rejected. */
  readonly fetch_settled_at?: string;
  readonly fetch_outcome?: 'response' | 'failure';
  readonly http_status?: number;
  /** Redirect-style retry through the same dispatcher would show >1. */
  readonly dispatches?: number;
  readonly send_state: RequestSendState;
  readonly timeout_layer?: TransportTimeoutLayer;
  /**
   * The request's composed AbortSignal OBSERVABLY fired while the wire was
   * live — the signal listener ran (or the signal arrived already aborted at
   * fetch invoke), tracked across the whole wire lifecycle including the
   * post-headers window where the fetch promise has already resolved. Never
   * inferred from an abort-shaped error name/code: a bare transport
   * `AbortError` of unknown origin leaves this unset.
   */
  readonly signal_aborted?: boolean;
  /** Sanitized name/code of `signal.reason` observed at abort time. */
  readonly signal_reason?: { readonly name: string; readonly code?: string | number };
  /**
   * Which recorded initiator fired no later than this observed signal abort.
   * `unknown` when none did — e.g. the SDK's own timer, whose error type only
   * exists outside the fetch layer. Emitted only alongside `signal_aborted`.
   */
  readonly signal_initiator?: TransportAbortInitiator | 'unknown';
  readonly error?: TransportFailureEvidence;
}

export interface ProviderTransportBudgetReceipt {
  /** The resolved task budget — the single source every layer derives from. */
  readonly task_timeout_ms: number;
  readonly timeout_source?: TaskTimeoutSource;
  /** Caller's absolute session bound, when one was supplied. */
  readonly caller_deadline_at?: string;
  /** The exact bound the lifecycle armed: min(task, deadline remaining). */
  readonly execution_timeout_ms?: number;
  /** The SDK per-request timeout actually handed to the pi drivers. */
  readonly sdk_timeout_ms?: number;
  readonly sdk_timeout_source?: 'task_budget' | 'sdk_default';
  /**
   * The undici timers installed on the attempt's dispatcher — emitted ONLY
   * when at least one dispatch actually rode it. When the fetch
   * implementation bypassed our dispatcher the timers never applied, so the
   * receipt omits them rather than claiming they governed.
   */
  readonly connect_timeout_ms?: number;
  readonly headers_timeout_ms?: number;
  readonly body_timeout_ms?: number;
  readonly http_margin_ms?: number;
}

export interface ProviderTransportEvidence {
  readonly v: 1;
  readonly budget: ProviderTransportBudgetReceipt;
  /** Transport(s) this attempt's requests actually used. */
  readonly lane: 'undici_agent' | 'observer_fetch' | 'mixed' | 'none';
  /**
   * Run-level rollup over EVERY observed request (retained or truncated);
   * never masks an earlier send. 'not_sent' requires every invoked request to
   * carry positive not-sent evidence with nothing pending.
   */
  readonly send_state: TransportSendState;
  /** Aggregates over all requests, independent of `requests` truncation. */
  readonly totals: {
    readonly requests: number;
    readonly dispatches: number;
    readonly by_state: Record<RequestSendState, number>;
  };
  /**
   * Neutral raw transport error/abort evidence — the most recent error ANY
   * request produced, whatever it means: transport failure, attributed
   * timeout, caller cancellation, or a bare abort of unknown origin (e.g.
   * the body-cancel a successful SDK stream-end cleanup emits). Survives
   * `requests` truncation so the final error is never silently dropped; by
   * itself it is NOT a failure verdict.
   */
  readonly last_transport_error?: {
    readonly seq: number;
    readonly at?: string;
    readonly send_state: RequestSendState;
    /** Emitted only when the composed AbortSignal observably fired. */
    readonly signal_aborted?: boolean;
    readonly signal_initiator?: TransportAbortInitiator | 'unknown';
    readonly signal_reason?: { readonly name: string; readonly code?: string | number };
    readonly error: TransportFailureEvidence;
  };
  /**
   * The most recent VERIFIED transport/timeout failure — an error carrying
   * a classified `timeout_layer`, or substantive non-abort evidence
   * somewhere in its cause chain. A bare abort-only error stays in
   * `last_transport_error` and never lands here. Survives `requests`
   * truncation.
   */
  readonly last_failure?: {
    readonly seq: number;
    readonly at?: string;
    readonly send_state: RequestSendState;
    readonly timeout_layer?: TransportTimeoutLayer;
    readonly error?: TransportFailureEvidence;
  };
  /** Initiating-layer abort events this lifecycle recorded, in order. */
  readonly abort_initiators?: readonly TransportAbortMarker[];
  readonly requests: readonly ProviderRequestEvidence[];
  readonly requests_seen: number;
  readonly requests_dropped: number;
  readonly captured_at: string;
}

export function aiAgentRef(
  kind: string,
  result: TaskTextResult,
): {
  by: 'ai';
  task_kind: string;
  task_run_id?: string;
} {
  return {
    by: 'ai',
    task_kind: kind,
    ...(result.task_run_id ? { task_run_id: result.task_run_id } : {}),
  };
}
