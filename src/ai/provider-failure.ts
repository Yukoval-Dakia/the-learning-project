// Provider-failure classification for truthful learner-facing failure wire.
//
// Categories derive from structured evidence — the bound HTTP status,
// AgentRunError subtype, and the transport collector's armed timers. One
// narrow exception: separating a short 429 congestion from an account-level
// quota reads the provider's OWN quota code words inside the sanitized
// failure body — free-prose message matching never decides anything else.
// `retry_after_ms` is the provider's own Retry-After when the response
// carried one; absent means unknown, not zero.

import { type AgentFailureSubtype, AgentRunError } from './agent-run-error';
import type { ProviderTransportEvidence } from './task-result';

export type ProviderFailureCategory =
  /** Bound HTTP 429 (quota / rate limit). */
  | 'rate_limited'
  /** Bound HTTP 429 whose body carries the provider's own quota/limit signature. */
  | 'quota'
  /** Bound 4xx refusal, including the 400 request rejection. */
  | 'provider_rejected'
  /** Bound 5xx, or a provider-side error after a delivered response. */
  | 'provider_error'
  /** An armed execution/session timer fired. */
  | 'timeout'
  /** No bound response — connect failure or mid-stream drop. */
  | 'connection';

export interface ProviderFailureInfo {
  readonly category: ProviderFailureCategory;
  readonly http_status?: number;
  readonly retry_after_ms?: number;
}

export function providerFailureCategoryForStatus(status: number): ProviderFailureCategory {
  if (status === 429) return 'rate_limited';
  if (status >= 400 && status < 500) return 'provider_rejected';
  return 'provider_error';
}

/**
 * Classify one failed attempt into a learner-safe category, or return undefined
 * when no provider failure is proven (caller cancellation, turn ceilings,
 * contract violations and unknown exceptions stay unclassified).
 */
export function classifyProviderFailure(input: {
  subtype?: AgentFailureSubtype;
  /** api_error_result status; null marks connection-class. */
  apiErrorStatus?: number | null;
  /**
   * HTTP status bound to the request that failed at termination (strict root
   * binding or the transport snapshot's last request). An earlier non-2xx from
   * a recovered or nested request must not arrive here.
   */
  httpStatus?: number;
  retryAfterMs?: number;
  /**
   * Sanitized provider failure evidence lines — where the quota signature
   * lives. Only consulted on a bound 429: the provider's own code words split
   * account-level quota from brief congestion.
   */
  errorEvidence?: readonly string[];
  /** Terminal carried the provider stream-error shape (stopReason 'error'). */
  streamErrorTerminal?: boolean;
  transport?: ProviderTransportEvidence;
}): ProviderFailureInfo | undefined {
  const retry = input.retryAfterMs !== undefined ? { retry_after_ms: input.retryAfterMs } : {};
  const bound = input.apiErrorStatus ?? input.httpStatus;
  if (bound !== undefined && bound !== null && bound >= 400 && bound <= 599) {
    return {
      category:
        bound === 429 && providerQuotaLimitSigned(input.errorEvidence ?? [])
          ? 'quota'
          : providerFailureCategoryForStatus(bound),
      http_status: bound,
      ...retry,
    };
  }
  if (input.apiErrorStatus === null) return { category: 'connection', ...retry };

  const initiators = (input.transport?.abort_initiators ?? []).map((marker) => marker.kind);
  // Rollups (last_failure, send_state) can survive an earlier recovered request;
  // only the request that was live at termination is probative — and only when
  // the terminating (root) loop issued it: a nested loop's tail request cannot
  // be the root's terminal cause.
  const lastRequest = input.transport?.requests.at(-1);
  const terminalRequest = lastRequest?.loop === 'root' ? lastRequest : undefined;
  const timedOut =
    terminalRequest?.timeout_layer !== undefined ||
    initiators.some((kind) => kind === 'execution_timeout' || kind === 'session_deadline');
  if (timedOut) return { category: 'timeout', ...retry };
  // budget_timeout is the lifecycle's armed-timer identity; a caller-driven
  // abort reaching the same subtype stays unclassified rather than mislabeled.
  if (input.subtype === 'budget_timeout') {
    const callerAborted = initiators.some(
      (kind) => kind === 'caller_signal' || kind === 'lifecycle_abort',
    );
    if (!callerAborted) return { category: 'timeout', ...retry };
    return undefined;
  }

  if (input.subtype === 'stream_no_terminal' || input.subtype === 'api_error_result') {
    return { category: 'connection', ...retry };
  }
  if (input.subtype === 'error_during_execution') {
    // Positive provider evidence only: a verified transport failure is a
    // connection-class drop; a provider stream-error terminal is provider-side.
    // A local loop death after clean requests stays unclassified.
    if (terminalRequest?.error !== undefined) {
      return { category: 'connection', ...retry };
    }
    if (input.streamErrorTerminal) return { category: 'provider_error', ...retry };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Bounded provider-transient retry (YUK-1876)
// ---------------------------------------------------------------------------

/**
 * The terminal failure's bound HTTP status, or null when no status is proven.
 * Priority: the runner-bound api_error_status, then the adapter-bound
 * provider_failure status, then the observed final root request — and that last
 * source only when no request is in flight/unknown/sent_without_response, so a
 * status can never be fabricated onto an uncertain wire.
 */
export function boundTerminalHttpStatus(
  error: AgentRunError,
  transport?: ProviderTransportEvidence,
): number | null {
  if (error.apiErrorStatus != null && error.apiErrorStatus >= 400) return error.apiErrorStatus;
  const bound = error.providerFailure?.http_status;
  if (bound != null && bound >= 400) return bound;
  return settledTransportHttpStatus(transport);
}

/**
 * The observed final root request's ≥400 status — the only transport-derived
 * bound, valid solely when every request provably settled (zero in-flight,
 * unknown, or sent_without_response). Single owner of that third-leg check:
 * `boundTerminalHttpStatus` and the row-driven provider-wait planner both read
 * it, so an uncertain wire can never fabricate a status in either path.
 */
export function settledTransportHttpStatus(transport?: ProviderTransportEvidence): number | null {
  const last = transport?.requests.at(-1);
  if (
    last?.loop === 'root' &&
    last.send_state === 'response_received' &&
    last.http_status != null &&
    last.http_status >= 400 &&
    transport?.totals.by_state.in_flight === 0 &&
    transport.totals.by_state.unknown === 0 &&
    transport.totals.by_state.sent_without_response === 0
  )
    return last.http_status;
  return null;
}

/** Provider failures that are positively proven — naming the refusal, not its bound. */
export type ProviderTransientClass =
  /** Bound HTTP 429 naming short congestion — Retry-After wins the delay. */
  | 'rate_limited'
  /**
   * Bound HTTP 429 whose provider body carries an account-level quota signature —
   * a days-scale wait the in-run budget cannot outlast. Never resent; the caller
   * maps it to its durable wait (admission quota waiting / sealed help exit).
   */
  | 'quota_exhausted'
  /** Bound HTTP 5xx — a completed, pre-billing rejection. */
  | 'server_error'
  /** A pi bad-gateway fault — a completed rejection. */
  | 'bad_gateway'
  /** Bound HTTP 408/409 — the provider rejected without processing the call. */
  | 'request_rejected'
  /** Transport proves the request never reached the wire — nothing to bill. */
  | 'not_sent';

/**
 * Provider-emitted quota/usage-limit code words. A bare 429 stays congestion
 * (resendable); only the provider's own signature in the failure evidence
 * promotes it to quota_exhausted — "rate limit"/"too many requests" prose must
 * not match, and absence of a signature never means quota.
 */
const PROVIDER_QUOTA_LIMIT_SIGNATURE =
  /GoUsageLimitError|usage[_ -]?limit|quota[_ -]?exceeded|billing[_ -]?limit|insufficient[_ -]?(?:quota|balance|credit)|(?:weekly|monthly|daily|hourly)[_ -]?(?:usage|quota|limit)/i;

/** Do any evidence lines carry the provider's own quota/usage-limit code words? */
export function providerQuotaLimitSigned(entries: readonly string[]): boolean {
  return entries.some((entry) => PROVIDER_QUOTA_LIMIT_SIGNATURE.test(entry));
}

/**
 * Status-level verdict for lanes that fail a request outside AgentRunError
 * (raw provider fetches like GLM OCR). Same owner, same classes — a bound
 * status is positive provider evidence; everything else stays unclassified.
 */
export function providerTransientClassForStatus(input: {
  httpStatus: number;
  /** Sanitized provider error evidence lines the quota signature may read. */
  errorEvidence?: readonly string[];
  retryAfterMs?: number;
}): ProviderTransientVerdict | undefined {
  const retryAfter = input.retryAfterMs !== undefined ? { retryAfterMs: input.retryAfterMs } : {};
  if (input.httpStatus === 429) {
    return {
      class: providerQuotaLimitSigned(input.errorEvidence ?? [])
        ? 'quota_exhausted'
        : 'rate_limited',
      httpStatus: 429,
      ...retryAfter,
    };
  }
  if (input.httpStatus === 408 || input.httpStatus === 409)
    return { class: 'request_rejected', httpStatus: input.httpStatus, ...retryAfter };
  if (input.httpStatus >= 500)
    return { class: 'server_error', httpStatus: input.httpStatus, ...retryAfter };
  return undefined;
}

/**
 * May a verdict's class re-issue the request inside the bounded budget? Every
 * class except quota_exhausted is a complete, provably unbilled refusal.
 */
export function providerTransientResendable(cls: ProviderTransientClass): boolean {
  return cls !== 'quota_exhausted';
}

export interface ProviderTransientVerdict {
  readonly class: ProviderTransientClass;
  /** The bound status for HTTP classes; absent for 'not_sent'. */
  readonly httpStatus?: number;
  /** The provider's own retry hint when it rode the bound rejection. */
  readonly retryAfterMs?: number;
}

/**
 * The single owner of "may this settled provider failure be re-issued?".
 * Every class requires positive evidence: a bound status or a transport-level
 * not_sent proof. `sent_without_response`, `unknown`, `in_flight`, timeouts and
 * caller cancellation are never retryable — resending an uncertain request can
 * double-bill. Callers bound retries and delays; this only names the class.
 */
export function providerTransientVerdict(input: {
  error: unknown;
  transport?: ProviderTransportEvidence;
}): ProviderTransientVerdict | undefined {
  const error = input.error;
  if (!(error instanceof AgentRunError)) return undefined;
  const bound = boundTerminalHttpStatus(error, input.transport);
  const retryAfter =
    error.providerFailure?.http_status === bound &&
    error.providerFailure.retry_after_ms !== undefined
      ? { retryAfterMs: error.providerFailure.retry_after_ms }
      : {};
  if (error.helpProviderFault?.kind === 'bad_gateway')
    return { class: 'bad_gateway', httpStatus: 502, ...retryAfter };
  if (bound != null)
    return providerTransientClassForStatus({
      httpStatus: bound,
      errorEvidence: error.errors,
      ...(retryAfter.retryAfterMs !== undefined ? { retryAfterMs: retryAfter.retryAfterMs } : {}),
    });
  if (input.transport?.send_state === 'not_sent') return { class: 'not_sent' };
  return undefined;
}

/**
 * Whitelist-only transient predicate — the error-only projection of
 * `providerTransientVerdict`. Anything not an AgentRunError (budget aborts,
 * config errors, unknown throws) is permanent by default; a verdict class that
 * never resends (quota_exhausted) is likewise not transient for the caller.
 */
export function isTransientAgentFailure(
  err: unknown,
  transport?: ProviderTransportEvidence,
): boolean {
  const verdict = providerTransientVerdict({ error: err, transport });
  return verdict !== undefined && providerTransientResendable(verdict.class);
}
