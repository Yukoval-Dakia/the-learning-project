import type { Dispatcher } from 'undici';
import { Agent } from 'undici';
import type { TaskTimeoutSource } from '@/ai/task-budget';
import { truncateUtf8 } from '@/core/raw-arguments-evidence';
import { sanitizeProviderErrorText } from './provider-error-evidence';

/**
 * YUK-1630 — pi provider-lane transport + per-request wire evidence.
 *
 * One npm-undici Agent per lifecycle attempt carries connect/headers/body
 * timers that all derive from the same resolved task budget (the value the
 * runner computes via `providerHttpTimeoutMs`). The SDK per-request timeout
 * gets the identical derived value, so every HTTP-layer timer traces back to
 * a single source instead of the old mix of "SDK default 600s / undici
 * default 300s / connect default 10s".
 *
 * Transport composition (R1): the instrumented fetch always invokes the
 * CURRENT `globalThis.fetch` with our dispatcher injected into `init`.
 * A pass-through observer wrapper therefore still rides the controlled
 * Agent; a fetch that ignores `init.dispatcher` (test stub) simply never
 * produces `dispatch()` calls on it, and that request is reported on the
 * `observer_fetch` lane with `unknown` wire state — never fabricated
 * `not_sent`. Handler-shape bridging covers both undici generations: Node's
 * builtin fetch (undici 7) passes a legacy handler (onConnect/onHeaders/
 * onData/onComplete/onError) while the npm undici 8 Agent invokes the modern
 * surface (onRequestStart/onResponseStart/onResponseData/onResponseEnd/
 * onResponseError); the dispatcher translates whichever it receives.
 *
 * Evidence semantics (the ticket's core requirement):
 * - `onRequestStart` = the request began executing on a socket; bytes may or
 *   may not have reached the wire yet.
 * - `onRequestSent` = undici finished writing the complete request (headers +
 *   full body) to the socket. `undici:client:sendHeaders` fires BEFORE any
 *   write, so it can never stand in for this.
 * - `onResponseStarted`/`onResponseStart` = the peer began answering.
 * `not_sent` is claimed ONLY on positive evidence — our own dispatcher saw a
 * request end (via `onResponseError`) before `onRequestStart`, i.e. it never
 * began a socket write (connect/queue failure). Anything partially written,
 * still pending, or observed through a foreign fetch stays
 * `unknown`/`in_flight`; a later request's `not_sent` never masks an earlier
 * request that did send.
 *
 * Timeout-layer attribution is honest about what the wire can see:
 * - undici error codes identify connect/headers/body directly.
 * - An abort reaches the wire as the composed signal firing (DOMException
 *   `AbortError` / `UND_ERR_ABORTED`) — `timeout_layer: 'signal'` plus
 *   `signal_initiator` from `abort_initiators`, which the lifecycle records
 *   synchronously at the layer that actually called `abort()` (execution
 *   timer, session deadline, caller signal, lease loss, or generic abort).
 *   The OpenAI SDK builds `APIConnectionTimeoutError` OUTSIDE fetch, so the
 *   inner transport never sees it — when no initiator marker precedes the
 *   abort the initiator stays `unknown` rather than being guessed from the
 *   configured timeout value.
 *
 * The scope of `send_state` is this attempt's provider model-request lane —
 * everything the pi drivers route through `options.fetch` (root loop, nested
 * subagent loops and SDK-internal retries all funnel through the same
 * instrumented fetch). Other lanes (typed-primitive runner, provider /models
 * check) have their own transports and never attach this evidence.
 */

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
   * The SDK whole-request timer. Never produced by wire classification alone:
   * the SDK wraps its abort into an SDK error type OUTSIDE fetch, so the
   * transport only observes the composed signal firing.
   */
  | 'sdk'
  /**
   * The fetch's composed AbortSignal ended the request. `signal_initiator`
   * carries which layer initiated it when the lifecycle recorded one.
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
   * The request's composed AbortSignal fired while the wire was live — tracked
   * across the whole wire lifecycle, including the post-headers window where
   * the fetch promise has already resolved.
   */
  readonly signal_aborted?: boolean;
  /** Sanitized name/code of `signal.reason` observed at abort time. */
  readonly signal_reason?: { readonly name: string; readonly code?: string | number };
  /**
   * Which recorded initiator fired no later than this signal abort. `unknown`
   * when none did — e.g. the SDK's own timer, whose error type only exists
   * outside the fetch layer.
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
  /** The most recent failure — survives `requests` truncation. */
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

const MAX_REQUEST_RECORDS = 32;
const MAX_ABORT_MARKERS = 8;
const FAILURE_MESSAGE_MAX_BYTES = 512;
const CAUSE_CHAIN_MAX_DEPTH = 3;

interface MutableBudgetReceipt {
  task_timeout_ms: number;
  timeout_source?: TaskTimeoutSource;
  caller_deadline_at?: string;
  execution_timeout_ms?: number;
  sdk_timeout_ms?: number;
  sdk_timeout_source?: 'task_budget' | 'sdk_default';
  connect_timeout_ms?: number;
  headers_timeout_ms?: number;
  body_timeout_ms?: number;
  http_margin_ms?: number;
}

interface MutableRequestRecord {
  seq: number;
  /** Incremented per `dispatch()` — >0 means this call rode our dispatcher. */
  dispatches: number;
  handlerApi?: 'modern' | 'legacy';
  fetchInvokedAt: string;
  requestStartedAt?: string;
  requestSentAt?: string;
  responseStartedAt?: string;
  responseHeadersAt?: string;
  endedAt?: string;
  fetchSettledAt?: string;
  fetchOutcome?: 'response' | 'failure';
  httpStatus?: number;
  wireError?: TransportFailureEvidence;
  fetchError?: TransportFailureEvidence;
  signalAbortedAt?: string;
  signalReason?: TransportFailureEvidence;
  /** Removes the wire-lifecycle signal listener installed at fetch time. */
  detachSignalListener?: () => void;
  /** Running classification — mirrored into the collector's aggregate counts. */
  state: RequestSendState;
}

const now = (): string => new Date().toISOString();

export interface ProviderTransportCollectorInit {
  readonly taskTimeoutMs: number;
  readonly timeoutSource?: TaskTimeoutSource;
  readonly callerDeadlineAt?: number;
}

export class ProviderTransportCollector {
  private readonly budget: MutableBudgetReceipt;
  private secrets: readonly string[] = [];
  private records: MutableRequestRecord[] = [];
  private requestsSeen = 0;
  private requestsDropped = 0;
  private dispatchesSeen = 0;
  private seq = 0;
  private armed = false;
  private armedTimers:
    | {
        connectTimeoutMs: number;
        headersTimeoutMs: number;
        bodyTimeoutMs: number;
        marginMs?: number;
      }
    | undefined;
  /** Counts over EVERY request — the rollup never depends on `records`. */
  private readonly stateCounts: Record<RequestSendState, number> = {
    not_sent: 0,
    sent_without_response: 0,
    response_received: 0,
    unknown: 0,
    in_flight: 0,
  };
  private lastFailure: ProviderTransportEvidence['last_failure'];
  private readonly abortInitiators: TransportAbortMarker[] = [];
  /** Lanes observed over ALL requests — survives `records` truncation. */
  private readonly lanesSeen = new Set<TransportLane>();

  constructor(init: ProviderTransportCollectorInit) {
    this.budget = {
      task_timeout_ms: init.taskTimeoutMs,
      ...(init.timeoutSource !== undefined ? { timeout_source: init.timeoutSource } : {}),
      ...(init.callerDeadlineAt !== undefined
        ? { caller_deadline_at: new Date(init.callerDeadlineAt).toISOString() }
        : {}),
    };
  }

  /**
   * Whether any consumer armed the controlled transport. `usage.transport` is
   * attached only when armed — an unobserved lane (e.g. the typed-primitive
   * runner's direct POST) must not produce an empty `not_sent` receipt.
   */
  get isArmed(): boolean {
    return this.armed;
  }

  /** Credentials to redact inside failure messages; set by the fetch factory. */
  setSecrets(secrets: readonly string[]): void {
    this.secrets = secrets;
  }

  /** The attempt's instrumented fetch was built — the provider lane is armed. */
  noteArmed(): void {
    this.armed = true;
  }

  /** A dispatch passed through the controlled dispatcher. */
  noteDispatch(): void {
    this.dispatchesSeen += 1;
  }

  /**
   * The lifecycle is about to call `abort()`. Recorded synchronously BEFORE
   * the signal fires so the marker's timestamp provably precedes the wire
   * abort it causes; only the initiator that transitions the signal counts.
   */
  noteAbortInitiated(kind: TransportAbortInitiator): void {
    if (this.abortInitiators.length >= MAX_ABORT_MARKERS) return;
    this.abortInitiators.push({ at: now(), kind });
  }

  /** The exact bound the lifecycle armed — min(task budget, deadline remaining). */
  noteExecutionTimeoutMs(timeoutMs: number): void {
    this.budget.execution_timeout_ms = timeoutMs;
  }

  /** Which per-request timeout value was handed to the pi drivers. */
  noteSdkTimeout(input: { sdkTimeoutMs: number; source: 'task_budget' | 'sdk_default' }): void {
    this.budget.sdk_timeout_ms = input.sdkTimeoutMs;
    this.budget.sdk_timeout_source = input.source;
  }

  /**
   * The undici timers installed on the attempt's dispatcher. Emitted into the
   * receipt only once a dispatch actually rode it.
   */
  noteTransportTimers(input: {
    connectTimeoutMs: number;
    headersTimeoutMs: number;
    bodyTimeoutMs: number;
    marginMs?: number;
  }): void {
    this.armedTimers = input;
  }

  beginFetch(): MutableRequestRecord {
    this.requestsSeen += 1;
    const record: MutableRequestRecord = {
      seq: this.seq,
      dispatches: 0,
      fetchInvokedAt: now(),
      state: 'in_flight',
    };
    this.seq += 1;
    this.stateCounts.in_flight += 1;
    if (this.records.length < MAX_REQUEST_RECORDS) {
      this.records.push(record);
    } else {
      this.requestsDropped += 1;
    }
    return record;
  }

  /**
   * Re-derive the record's send state after any mutation and keep the
   * aggregate counts + last-failure slot current — including for records that
   * were already truncated out of `records`.
   */
  touch(record: MutableRequestRecord): void {
    // A lane is decided once the dispatcher saw the call, or once the fetch
    // settled/ended without ever dispatching — an in-flight record that has
    // not dispatched yet must not pre-claim the observer lane.
    if (record.dispatches > 0) {
      this.lanesSeen.add('undici_agent');
    } else if (record.fetchSettledAt !== undefined || record.endedAt !== undefined) {
      this.lanesSeen.add('observer_fetch');
    }
    const next = this.requestSendState(record);
    if (next !== record.state) {
      this.stateCounts[record.state] -= 1;
      this.stateCounts[next] += 1;
      record.state = next;
    }
    const error = record.wireError ?? record.fetchError;
    if (error !== undefined) {
      const timeoutLayer = classifyTimeoutLayer(error, this.signalAborted(record));
      this.lastFailure = {
        seq: record.seq,
        ...(record.endedAt !== undefined || record.fetchSettledAt !== undefined
          ? { at: record.endedAt ?? record.fetchSettledAt }
          : {}),
        send_state: next,
        ...(timeoutLayer !== undefined ? { timeout_layer: timeoutLayer } : {}),
        error,
      };
    }
  }

  recordFetchSettled(record: MutableRequestRecord, status: number): void {
    record.fetchSettledAt = now();
    record.fetchOutcome = 'response';
    record.httpStatus = status;
    this.touch(record);
  }

  /**
   * The fetch promise rejected. The wire may still be live — the dispatcher
   * path keeps reporting `onResponseError`; the signal listener is released
   * here since a settled failure cannot still be signal-driven.
   */
  recordFetchFailure(record: MutableRequestRecord, error: unknown): void {
    record.fetchSettledAt = now();
    record.fetchOutcome = 'failure';
    record.fetchError ??= this.captureError(error);
    record.detachSignalListener?.();
    this.touch(record);
  }

  /** Bounded, sanitized {name, code, message, cause} — never headers/key/body. */
  captureError(error: unknown): TransportFailureEvidence {
    return failureEvidence(error, { secrets: this.secrets });
  }

  private signalAborted(record: MutableRequestRecord): boolean {
    return (
      record.signalAbortedAt !== undefined || isSignalAbort(record.wireError ?? record.fetchError)
    );
  }

  private signalInitiator(
    record: MutableRequestRecord,
  ): TransportAbortInitiator | 'unknown' | undefined {
    if (!this.signalAborted(record)) return undefined;
    const abortedAt =
      record.signalAbortedAt !== undefined ? Date.parse(record.signalAbortedAt) : Number.NaN;
    // A lifecycle marker recorded no later than the wire abort is positive
    // initiator evidence (the marker is written synchronously before abort()
    // fires). +1ms absorbs same-tick ms rounding; everything else stays
    // 'unknown' — in particular the SDK's own timer, which surfaces only as
    // an SDK error type constructed outside fetch.
    if (Number.isNaN(abortedAt)) {
      // Signal-inferred abort without a listener timestamp: only a single
      // recorded initiator is unambiguous.
      return this.abortInitiators.length === 1 ? this.abortInitiators[0].kind : 'unknown';
    }
    let matched: TransportAbortInitiator | undefined;
    for (const marker of this.abortInitiators) {
      if (Date.parse(marker.at) <= abortedAt + 1) matched = marker.kind;
    }
    return matched ?? 'unknown';
  }

  private requestSendState(record: MutableRequestRecord): RequestSendState {
    const onWire = record.dispatches > 0;
    if (record.responseStartedAt !== undefined || record.responseHeadersAt !== undefined) {
      return 'response_received';
    }
    if (record.requestSentAt !== undefined) return 'sent_without_response';
    if (record.requestStartedAt !== undefined) {
      // Writing began but never completed — a partial send is possible.
      return 'unknown';
    }
    if (record.endedAt !== undefined && onWire) {
      // Our dispatcher settled the request before it ever began a socket
      // write — connect/queue failure: positive not_sent evidence.
      return 'not_sent';
    }
    if (record.fetchSettledAt !== undefined) {
      if (!onWire) {
        // A resolved foreign fetch means the caller saw a response; a
        // rejection proves nothing about the wire underneath.
        return record.fetchOutcome === 'response' ? 'response_received' : 'unknown';
      }
      // Our undici lane always reports wire milestones; missing ones mean the
      // dispatch never ran — treat as unknown rather than claiming not_sent.
      return 'unknown';
    }
    return 'in_flight';
  }

  snapshot(): ProviderTransportEvidence {
    const requests = this.records.map((record): ProviderRequestEvidence => {
      const error = record.wireError ?? record.fetchError;
      const timeoutLayer = classifyTimeoutLayer(error, this.signalAborted(record));
      const initiator = this.signalInitiator(record);
      const lane: TransportLane | undefined =
        record.dispatches > 0
          ? 'undici_agent'
          : record.fetchSettledAt !== undefined || record.endedAt !== undefined
            ? 'observer_fetch'
            : undefined;
      return {
        seq: record.seq,
        ...(lane !== undefined ? { lane } : {}),
        ...(record.handlerApi !== undefined ? { handler_api: record.handlerApi } : {}),
        fetch_invoked_at: record.fetchInvokedAt,
        ...(record.requestStartedAt !== undefined
          ? { request_started_at: record.requestStartedAt }
          : {}),
        ...(record.requestSentAt !== undefined ? { request_sent_at: record.requestSentAt } : {}),
        ...(record.responseStartedAt !== undefined
          ? { response_started_at: record.responseStartedAt }
          : {}),
        ...(record.responseHeadersAt !== undefined
          ? { response_headers_at: record.responseHeadersAt }
          : {}),
        ...(record.endedAt !== undefined ? { ended_at: record.endedAt } : {}),
        ...(record.fetchSettledAt !== undefined ? { fetch_settled_at: record.fetchSettledAt } : {}),
        ...(record.fetchOutcome !== undefined ? { fetch_outcome: record.fetchOutcome } : {}),
        ...(record.httpStatus !== undefined ? { http_status: record.httpStatus } : {}),
        ...(record.dispatches > 1 ? { dispatches: record.dispatches } : {}),
        send_state: record.state,
        ...(timeoutLayer !== undefined ? { timeout_layer: timeoutLayer } : {}),
        ...(this.signalAborted(record) ? { signal_aborted: true } : {}),
        ...(record.signalReason !== undefined
          ? {
              signal_reason: {
                name: record.signalReason.name,
                ...(record.signalReason.code !== undefined
                  ? { code: record.signalReason.code }
                  : {}),
              },
            }
          : {}),
        ...(initiator !== undefined ? { signal_initiator: initiator } : {}),
        ...(error !== undefined ? { error } : {}),
      };
    });
    const counts = this.stateCounts;
    const sendState: TransportSendState =
      counts.response_received > 0
        ? 'response_received'
        : counts.sent_without_response > 0
          ? 'sent_without_response'
          : counts.not_sent > 0 && counts.unknown === 0 && counts.in_flight === 0
            ? 'not_sent'
            : this.requestsSeen === 0
              ? // The armed lane recorded zero fetch invocations — positive
                // evidence that nothing was sent through the provider lane.
                'not_sent'
              : 'unknown';
    return {
      v: 1,
      budget: {
        ...this.budget,
        // Only claim the undici timers when a dispatch actually rode the
        // controlled transport — a foreign fetch that ignored the dispatcher
        // never saw them.
        ...(this.dispatchesSeen > 0 && this.armedTimers !== undefined
          ? {
              connect_timeout_ms: this.armedTimers.connectTimeoutMs,
              headers_timeout_ms: this.armedTimers.headersTimeoutMs,
              body_timeout_ms: this.armedTimers.bodyTimeoutMs,
              ...(this.armedTimers.marginMs !== undefined
                ? { http_margin_ms: this.armedTimers.marginMs }
                : {}),
            }
          : {}),
      },
      lane:
        this.lanesSeen.size === 0
          ? 'none'
          : this.lanesSeen.size === 1
            ? [...this.lanesSeen][0]
            : 'mixed',
      send_state: sendState,
      totals: {
        requests: this.requestsSeen,
        dispatches: this.dispatchesSeen,
        by_state: { ...counts },
      },
      ...(this.lastFailure !== undefined ? { last_failure: this.lastFailure } : {}),
      ...(this.abortInitiators.length > 0 ? { abort_initiators: [...this.abortInitiators] } : {}),
      requests,
      requests_seen: this.requestsSeen,
      requests_dropped: this.requestsDropped,
      captured_at: now(),
    };
  }
}

export function createProviderTransportCollector(
  init: ProviderTransportCollectorInit,
): ProviderTransportCollector {
  return new ProviderTransportCollector(init);
}

/** Map a failure to the timeout layer that produced it, when identifiable. */
function classifyTimeoutLayer(
  error: TransportFailureEvidence | undefined,
  signalAborted: boolean,
): TransportTimeoutLayer | undefined {
  const codes = errorCodes(error);
  if (codes.has('UND_ERR_CONNECT_TIMEOUT')) return 'connect';
  if (codes.has('UND_ERR_HEADERS_TIMEOUT')) return 'headers';
  if (codes.has('UND_ERR_BODY_TIMEOUT')) return 'body';
  if (signalAborted || codes.has('UND_ERR_ABORTED')) return 'signal';
  return undefined;
}

function errorCodes(error: TransportFailureEvidence | undefined): Set<string> {
  const codes = new Set<string>();
  let current: TransportFailureEvidence | undefined = error;
  while (current !== undefined) {
    if (current.code !== undefined) codes.add(String(current.code));
    current = current.cause?.[0];
  }
  return codes;
}

/**
 * The abort surfaces to the wire as the signal reason — a DOMException
 * `AbortError`/`TimeoutError` (numeric `code` 20/23) or undici's UND_ERR_ABORTED.
 */
function isSignalAbort(error: TransportFailureEvidence | undefined): boolean {
  let current: TransportFailureEvidence | undefined = error;
  while (current !== undefined) {
    if (current.name === 'AbortError' || current.name === 'TimeoutError') return true;
    if (current.code === 20 || current.code === 23) return true;
    current = current.cause?.[0];
  }
  return false;
}

function failureEvidence(
  error: unknown,
  options: { secrets: readonly string[] },
  depth = 0,
): TransportFailureEvidence {
  const name = error instanceof Error ? error.name : 'Error';
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = truncateUtf8(
    sanitizeProviderErrorText(rawMessage, { secrets: [...options.secrets] }),
    FAILURE_MESSAGE_MAX_BYTES,
  );
  const codeValue = error instanceof Error && 'code' in error ? error.code : undefined;
  const code =
    typeof codeValue === 'string' || typeof codeValue === 'number' ? codeValue : undefined;
  const causeRaw =
    error instanceof Error && 'cause' in error ? (error as { cause?: unknown }).cause : undefined;
  const cause =
    causeRaw !== undefined && depth < CAUSE_CHAIN_MAX_DEPTH
      ? [failureEvidence(causeRaw, options, depth + 1)]
      : undefined;
  return {
    name,
    ...(code !== undefined ? { code } : {}),
    message,
    ...(cause !== undefined ? { cause } : {}),
  };
}

/**
 * Legacy DispatchHandler surface — what Node's builtin fetch (undici 7) hands
 * to `dispatcher.dispatch`. The npm undici 8 Agent only invokes the modern
 * surface, so a legacy inner handler must be translated (the same mapping
 * undici's own WrapHandler/LegacyHandlerWrapper performs).
 */
interface LegacyDispatchHandler {
  onConnect?(abort: (reason?: Error) => void, context?: unknown): void;
  onError?(err: Error): void;
  onUpgrade?(statusCode: number, headers: Buffer[] | string[] | null, socket: unknown): void;
  onResponseStarted?(): void;
  onHeaders?(
    statusCode: number,
    headers: Buffer[],
    resume: () => void,
    statusText: string,
  ): boolean;
  onData?(chunk: Buffer): boolean;
  onComplete?(trailers: Buffer[] | string[] | null): void;
  onBodySent?(chunk: unknown): void;
  onRequestSent?(): void;
}

type ModernDispatchHandler = Dispatcher.DispatchHandler;
type IncomingHandler = Partial<ModernDispatchHandler> & LegacyDispatchHandler;

/** Mirror of undici's `toRawHeaders`: object headers → flat latin1 Buffer pairs. */
function toRawHeaders(headers: Record<string, unknown>): Buffer[] {
  const raw: Buffer[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        raw.push(Buffer.from(name, 'latin1'), Buffer.from(`${entry}`, 'latin1'));
      }
    } else if (value !== undefined) {
      raw.push(Buffer.from(name, 'latin1'), Buffer.from(`${value}`, 'latin1'));
    }
  }
  return raw;
}

/** The controller's raw header array when present, else an object→raw conversion. */
function rawHeaders(controller: Dispatcher.DispatchController, headers: unknown): Buffer[] {
  const raw = controller.rawHeaders;
  if (raw !== undefined && raw !== null) return raw as Buffer[];
  return toRawHeaders((headers ?? {}) as Record<string, unknown>);
}

function rawTrailers(
  controller: Dispatcher.DispatchController,
  trailers: unknown,
): Buffer[] | null {
  const raw = controller.rawTrailers;
  if (raw !== undefined && raw !== null) return raw as Buffer[];
  if (trailers === undefined || trailers === null) return null;
  return toRawHeaders(trailers as Record<string, unknown>);
}

/**
 * Per-`dispatch()` wrapper around the attempt's Agent. One fetch call maps to
 * one record, so concurrent fetches can never cross-pollinate evidence. The
 * handler the fetch implementation supplies may be the modern undici 8
 * surface or the legacy undici 7 one (Node's builtin fetch); both are bridged
 * to the modern surface the npm Agent invokes, with milestones recorded on
 * the outer side regardless.
 */
class ObservedDispatcher {
  constructor(
    private readonly agent: Agent,
    private readonly httpTimeoutMs: number,
    private readonly record: MutableRequestRecord,
    private readonly collector: ProviderTransportCollector,
  ) {}

  get isMockActive(): boolean | undefined {
    return (this.agent as unknown as { isMockActive?: boolean }).isMockActive;
  }

  dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    const record = this.record;
    record.dispatches += 1;
    this.collector.noteDispatch();
    const inner = handler as IncomingHandler;
    record.handlerApi ??= typeof inner.onRequestStart === 'function' ? 'modern' : 'legacy';
    const observed =
      record.handlerApi === 'modern' ? this.modernHandler(inner) : this.legacyHandler(inner);
    // Reinforce the same budget-derived bound at the dispatch-options layer;
    // connect stays agent-level (no per-request option exists).
    const opts: Dispatcher.DispatchOptions = {
      ...options,
      headersTimeout: this.httpTimeoutMs,
      bodyTimeout: this.httpTimeoutMs,
    };
    return this.agent.dispatch(opts, observed);
  }

  private markRequestStarted(): void {
    this.record.requestStartedAt ??= now();
    this.collector.touch(this.record);
  }

  private markRequestSent(): void {
    this.record.requestSentAt ??= now();
    this.collector.touch(this.record);
  }

  private markResponseStarted(): void {
    this.record.responseStartedAt ??= now();
    this.collector.touch(this.record);
  }

  private markResponseHeaders(statusCode: number): void {
    this.record.responseHeadersAt ??= now();
    this.record.httpStatus = statusCode;
    this.collector.touch(this.record);
  }

  private markEnded(): void {
    this.record.endedAt ??= now();
    this.record.detachSignalListener?.();
    this.collector.touch(this.record);
  }

  private markWireError(error: unknown): void {
    this.record.wireError ??= this.collector.captureError(error);
  }

  /** Modern inner handler (npm undici 8 fetch): record + forward verbatim. */
  private modernHandler(inner: IncomingHandler): Dispatcher.DispatchHandler {
    return {
      onRequestStart: (controller, context) => {
        this.markRequestStarted();
        inner.onRequestStart?.(controller, context);
      },
      onRequestUpgrade: (controller, statusCode, headers, socket) =>
        inner.onRequestUpgrade?.(controller, statusCode, headers, socket),
      onRequestSent: () => {
        this.markRequestSent();
        inner.onRequestSent?.();
      },
      onResponseStarted: () => {
        this.markResponseStarted();
        inner.onResponseStarted?.();
      },
      onResponseStart: (controller, statusCode, headers, statusMessage) => {
        this.markResponseHeaders(statusCode);
        inner.onResponseStart?.(controller, statusCode, headers, statusMessage);
      },
      onResponseData: (controller, chunk) => inner.onResponseData?.(controller, chunk),
      onResponseEnd: (controller, trailers) => {
        this.markEnded();
        inner.onResponseEnd?.(controller, trailers);
      },
      onResponseError: (controller, error) => {
        this.markWireError(error);
        this.markEnded();
        inner.onResponseError?.(controller, error);
      },
      onBodySent: (chunk) => inner.onBodySent?.(chunk),
    };
  }

  /**
   * Legacy inner handler (Node builtin undici 7 fetch): the npm Agent calls
   * the modern surface on us; each call translates to the legacy method the
   * fetch implementation passed — the same translation undici's own
   * WrapHandler performs (rawHeaders come from the controller when present).
   */
  private legacyHandler(inner: IncomingHandler): Dispatcher.DispatchHandler {
    return {
      onRequestStart: (controller, context) => {
        this.markRequestStarted();
        inner.onConnect?.(
          (reason?: Error) =>
            controller.abort(
              reason ?? new DOMException('The operation was aborted.', 'AbortError'),
            ),
          context,
        );
      },
      onRequestUpgrade: (controller, statusCode, headers, socket) =>
        inner.onUpgrade?.(statusCode, rawHeaders(controller, headers), socket),
      onRequestSent: () => {
        this.markRequestSent();
        inner.onRequestSent?.();
      },
      onResponseStarted: () => {
        this.markResponseStarted();
        inner.onResponseStarted?.();
      },
      onResponseStart: (controller, statusCode, headers, statusMessage) => {
        this.markResponseHeaders(statusCode);
        const resume = () => controller.resume();
        const keepGoing = inner.onHeaders?.(
          statusCode,
          rawHeaders(controller, headers) as Buffer[],
          resume,
          statusMessage ?? '',
        );
        if (keepGoing === false) controller.pause();
      },
      onResponseData: (controller, chunk) => {
        if (inner.onData?.(chunk) === false) controller.pause();
      },
      onResponseEnd: (controller, trailers) => {
        this.markEnded();
        inner.onComplete?.(rawTrailers(controller, trailers));
      },
      onResponseError: (_controller, error) => {
        this.markWireError(error);
        this.markEnded();
        // npm undici 8 calls handler.onResponseError without a try/catch —
        // a throw would escape into the socket error path. A handler that
        // cannot absorb the error simply loses the callback; the wire
        // failure itself is already recorded above.
        inner.onError?.(error);
      },
      onBodySent: (chunk) => inner.onBodySent?.(chunk),
    };
  }
}

export interface BudgetedProviderFetch {
  readonly fetch: typeof fetch;
  readonly close: () => Promise<void>;
}

/**
 * Fetch for one attempt's provider lane. Every call invokes the CURRENT
 * `globalThis.fetch` with the attempt's dispatcher injected into
 * `init.dispatcher` — explicit composition, not identity-based bypass:
 *
 * - The platform fetch dispatches through the controlled Agent → full wire
 *   milestones + budget timers apply (Node builtin fetch passes a legacy
 *   handler; the bridge translates).
 * - An observer wrapper that forwards `init` still rides the same dispatcher
 *   — budget timers apply and milestones are recorded.
 * - A foreign fetch that ignores `init.dispatcher` never produces dispatches;
 *   its record stays on `observer_fetch` with `unknown` wire state, and the
 *   receipt omits the undici timers because they were never in effect.
 */
export function createBudgetedProviderFetch(input: {
  httpTimeoutMs: number;
  marginMs?: number;
  secrets: readonly string[];
  collector?: ProviderTransportCollector;
}): BudgetedProviderFetch {
  const agent = new Agent({
    connectTimeout: input.httpTimeoutMs,
    headersTimeout: input.httpTimeoutMs,
    bodyTimeout: input.httpTimeoutMs,
  });
  const collector = input.collector;
  collector?.setSecrets(input.secrets);
  collector?.noteArmed();
  collector?.noteTransportTimers({
    connectTimeoutMs: input.httpTimeoutMs,
    headersTimeoutMs: input.httpTimeoutMs,
    bodyTimeoutMs: input.httpTimeoutMs,
    ...(input.marginMs !== undefined ? { marginMs: input.marginMs } : {}),
  });
  const fetchImpl: typeof fetch = async (fetchInput, init) => {
    const record = collector?.beginFetch();
    // Track the composed signal across the WHOLE wire lifecycle: the fetch
    // promise resolves at response headers, while aborts during body
    // streaming only reach the dispatcher's onResponseError. signal.reason
    // (e.g. DOMException AbortError/TimeoutError, or a caller's custom
    // reason) is captured at abort time.
    const signal = (init as { signal?: AbortSignal | null } | undefined)?.signal;
    if (
      record !== undefined &&
      signal !== null &&
      signal !== undefined &&
      typeof signal.addEventListener === 'function'
    ) {
      if (signal.aborted) {
        record.signalAbortedAt = record.fetchInvokedAt;
        record.signalReason = collector?.captureError(signal.reason);
      } else {
        const onAbort = (): void => {
          // A post-wire-end abort is teardown noise, not a wire event.
          if (record.endedAt === undefined) {
            record.signalAbortedAt = now();
            record.signalReason = collector?.captureError(signal.reason);
            collector?.touch(record);
          }
        };
        signal.addEventListener('abort', onAbort, { once: true });
        record.detachSignalListener = () => signal.removeEventListener('abort', onAbort);
      }
    }
    try {
      // undici calls `dispatcher.dispatch(opts, handler)` — a plain object
      // satisfies the call; the casts only bridge the type surface (DOM
      // RequestInit has no `dispatcher` member; Node's fetch honors it).
      const observedInit = {
        ...(init ?? {}),
        dispatcher: (record !== undefined && collector !== undefined
          ? new ObservedDispatcher(agent, input.httpTimeoutMs, record, collector)
          : agent) as unknown as Dispatcher,
      } as RequestInit;
      const response = await globalThis.fetch(fetchInput, observedInit);
      if (record !== undefined) collector?.recordFetchSettled(record, response.status);
      return response;
    } catch (error) {
      if (record !== undefined) collector?.recordFetchFailure(record, error);
      throw error;
    }
  };
  return {
    fetch: fetchImpl,
    close: () => agent.close(),
  };
}
