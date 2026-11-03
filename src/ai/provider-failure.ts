// Provider-failure classification for truthful learner-facing failure wire.
//
// Categories derive only from structured evidence — the bound HTTP status,
// AgentRunError subtype, and the transport collector's armed timers — never
// from error-message string matching. `retry_after_ms` is the provider's own
// Retry-After when the response carried one; absent means unknown, not zero.

import type { AgentFailureSubtype } from './agent-run-error';
import type { ProviderTransportEvidence } from './task-result';

export type ProviderFailureCategory =
  /** Bound HTTP 429 (quota / rate limit). */
  | 'rate_limited'
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
  /** Terminal carried the provider stream-error shape (stopReason 'error'). */
  streamErrorTerminal?: boolean;
  transport?: ProviderTransportEvidence;
}): ProviderFailureInfo | undefined {
  const retry = input.retryAfterMs !== undefined ? { retry_after_ms: input.retryAfterMs } : {};
  const bound = input.apiErrorStatus ?? input.httpStatus;
  if (bound !== undefined && bound !== null && bound >= 400 && bound <= 599) {
    return {
      category: providerFailureCategoryForStatus(bound),
      http_status: bound,
      ...retry,
    };
  }
  if (input.apiErrorStatus === null) return { category: 'connection', ...retry };

  const initiators = (input.transport?.abort_initiators ?? []).map((marker) => marker.kind);
  // Rollups (last_failure, send_state) can survive an earlier recovered request;
  // only the request that was live at termination is probative.
  const lastRequest = input.transport?.requests.at(-1);
  const timedOut =
    lastRequest?.timeout_layer !== undefined ||
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
    if (lastRequest?.error !== undefined) {
      return { category: 'connection', ...retry };
    }
    if (input.streamErrorTerminal) return { category: 'provider_error', ...retry };
  }
  return undefined;
}
