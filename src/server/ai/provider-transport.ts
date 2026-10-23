import type { Dispatcher } from 'undici';
import { Agent } from 'undici';
import type { TaskTimeoutSource } from '@/ai/task-budget';
import type {
  ProviderRequestEvidence,
  ProviderTransportEvidence,
  RequestSendState,
  TransportAbortInitiator,
  TransportAbortMarker,
  TransportFailureEvidence,
  TransportLane,
  TransportSendState,
  TransportTimeoutLayer,
} from '@/ai/task-result';
import { truncateUtf8 } from '@/core/raw-arguments-evidence';
import { sanitizeProviderErrorText } from './provider-error-evidence';

/**
 * YUK-1630 — pi provider-lane transport + per-request wire evidence.
 *
 * One npm-undici Agent per lifecycle attempt carries connect/headers/body timers,
 * all derived from the same resolved task budget the SDK timeout gets. Transport
 * composition: the instrumented fetch invokes the CURRENT `globalThis.fetch` with
 * our dispatcher injected into `init`, so observer wrappers still ride the
 * controlled Agent; a fetch that ignores `init.dispatcher` produces no dispatch
 * evidence and is reported on the `observer_fetch` lane as `unknown`, never
 * fabricated `not_sent`. Legacy (undici 7) and modern (undici 8) handler shapes
 * are both bridged.
 *
 * Evidence rules:
 * - `not_sent` only on positive evidence: our dispatcher settled the request
 *   before `onRequestStart` (connect/queue failure). Anything partially written,
 *   pending, or behind a foreign fetch stays `unknown`/`in_flight`.
 * - `signal_aborted` only when the composed AbortSignal observably fired while the
 *   wire was live, never inferred from an abort-shaped error name.
 * - `timeout_layer: 'signal'` requires an observed abort attributed to the armed
 *   execution timer or the session deadline; every other abort stays unclassified.
 * - `last_transport_error` is neutral raw evidence; `last_failure` requires a
 *   classified timeout layer or substantive non-abort evidence.
 */

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
  private lastTransportError: ProviderTransportEvidence['last_transport_error'];
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
   * Whether a consumer armed the controlled transport. `usage.transport` attaches
   * only when armed — an unobserved lane must not produce an empty receipt.
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
   * Recorded synchronously BEFORE `abort()` fires so the marker provably precedes
   * the wire abort it causes.
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
   * Re-derive the record's state and keep aggregates current, including for
   * records already truncated out of `records`.
   */
  touch(record: MutableRequestRecord): void {
    // A lane is decided once the dispatcher saw the call, or once the fetch
    // settled without dispatching; an in-flight record cannot pre-claim it.
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
      const signalObserved = this.signalAborted(record);
      const initiator = this.signalInitiator(record);
      const timeoutLayer = classifyTimeoutLayer(error, signalObserved, initiator);
      const at =
        record.endedAt !== undefined || record.fetchSettledAt !== undefined
          ? (record.endedAt ?? record.fetchSettledAt)
          : undefined;
      // Neutral raw evidence — every error lands here, so the final wire error is
      // never silently dropped.
      this.lastTransportError = {
        seq: record.seq,
        ...(at !== undefined ? { at } : {}),
        send_state: next,
        ...(signalObserved ? { signal_aborted: true } : {}),
        ...(initiator !== undefined ? { signal_initiator: initiator } : {}),
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
        error,
      };
      // Verified failure: a classified timeout layer or substantive non-abort
      // evidence. A bare abort (caller cancel, stream-end cleanup) is not one.
      if (timeoutLayer !== undefined || !isBareAbort(error)) {
        this.lastFailure = {
          seq: record.seq,
          ...(at !== undefined ? { at } : {}),
          send_state: next,
          ...(timeoutLayer !== undefined ? { timeout_layer: timeoutLayer } : {}),
          error,
        };
      }
    }
  }

  recordFetchSettled(record: MutableRequestRecord, status: number): void {
    record.fetchSettledAt = now();
    record.fetchOutcome = 'response';
    record.httpStatus = status;
    this.touch(record);
  }

  /**
   * The fetch promise rejected while the wire may still be live (the dispatcher
   * keeps reporting onResponseError). Release the signal listener: a settled
   * failure cannot still be signal-driven.
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

  /**
   * Only the composed AbortSignal actually firing counts. An abort-shaped error
   * alone never claims one: `response.cancel()` and stream-end cleanup surface
   * `AbortError` without firing the signal.
   */
  private signalAborted(record: MutableRequestRecord): boolean {
    return record.signalAbortedAt !== undefined;
  }

  private signalInitiator(
    record: MutableRequestRecord,
  ): TransportAbortInitiator | 'unknown' | undefined {
    if (record.signalAbortedAt === undefined) return undefined;
    const abortedAt = Date.parse(record.signalAbortedAt);
    // A lifecycle marker recorded no later than the wire abort is positive
    // initiator evidence (markers are written before abort() fires). +1ms absorbs
    // same-tick rounding; everything else stays 'unknown'.
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
      const signalObserved = this.signalAborted(record);
      const initiator = this.signalInitiator(record);
      const timeoutLayer = classifyTimeoutLayer(error, signalObserved, initiator);
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
        ...(signalObserved ? { signal_aborted: true } : {}),
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
      ...(this.lastTransportError !== undefined
        ? { last_transport_error: this.lastTransportError }
        : {}),
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

/**
 * Map an error to its timeout layer on positive evidence only: undici timer codes,
 * or an observed signal abort the lifecycle attributed to the execution timer or
 * session deadline. Anything else stays unclassified rather than guessed.
 */
function classifyTimeoutLayer(
  error: TransportFailureEvidence | undefined,
  signalObserved: boolean,
  initiator: TransportAbortInitiator | 'unknown' | undefined,
): TransportTimeoutLayer | undefined {
  const codes = errorCodes(error);
  if (codes.has('UND_ERR_CONNECT_TIMEOUT')) return 'connect';
  if (codes.has('UND_ERR_HEADERS_TIMEOUT')) return 'headers';
  if (codes.has('UND_ERR_BODY_TIMEOUT')) return 'body';
  if (signalObserved && (initiator === 'execution_timeout' || initiator === 'session_deadline')) {
    return 'signal';
  }
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
 * Abort-family evidence: DOMException AbortError/TimeoutError, numeric 20/23, or
 * undici UND_ERR_ABORTED. Says nothing about which layer initiated it.
 */
function isAbortEvidence(error: TransportFailureEvidence): boolean {
  if (error.name === 'AbortError' || error.name === 'TimeoutError') return true;
  return (
    error.code === 20 ||
    error.code === 23 ||
    error.code === '20' ||
    error.code === '23' ||
    error.code === 'UND_ERR_ABORTED'
  );
}

/**
 * Every link of the cause chain is abort-family → cancellation of unattributed
 * origin, never a verified failure; any non-abort link is substantive evidence.
 */
function isBareAbort(error: TransportFailureEvidence): boolean {
  let current: TransportFailureEvidence | undefined = error;
  while (current !== undefined) {
    if (!isAbortEvidence(current)) return false;
    current = current.cause?.[0];
  }
  return true;
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
 * Legacy DispatchHandler surface (Node builtin fetch / undici 7). The npm undici 8
 * Agent only invokes the modern surface, so a legacy handler is translated the way
 * undici's own WrapHandler does.
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

/** Preserve H1 arrays; normalize H2 header objects for the legacy fetch handler. */
function rawHeaders(controller: Dispatcher.DispatchController, headers: unknown): Buffer[] {
  const raw = controller.rawHeaders ?? headers;
  if (Array.isArray(raw)) return raw as Buffer[];
  return toRawHeaders((raw ?? {}) as Record<string, unknown>);
}

function rawTrailers(
  controller: Dispatcher.DispatchController,
  trailers: unknown,
): Buffer[] | null {
  const raw = controller.rawTrailers ?? trailers;
  if (raw === undefined || raw === null) return null;
  if (Array.isArray(raw)) return raw as Buffer[];
  return toRawHeaders(raw as Record<string, unknown>);
}

/**
 * Per-`dispatch()` wrapper around the attempt's Agent: one fetch call maps to one
 * record, so concurrent fetches cannot cross-pollinate evidence. Both handler
 * shapes are bridged to the modern surface the npm Agent invokes.
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
   * Legacy inner handler: the npm Agent calls the modern surface on us; each call
   * translates to the legacy method the fetch implementation passed.
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
        // npm undici 8 calls onResponseError without a try/catch — a throw here
        // would escape into the socket error path. The wire failure is already
        // recorded above, so a handler that cannot absorb it just loses the
        // callback.
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
 * Fetch for one attempt's provider lane: every call invokes the CURRENT
 * `globalThis.fetch` with the attempt's dispatcher injected into `init`.
 *
 * - Platform/observer fetches dispatch through the controlled Agent → wire
 *   milestones and budget timers apply.
 * - A foreign fetch that ignores `init.dispatcher` stays on `observer_fetch` with
 *   `unknown` wire state; the receipt omits timers that were never in effect.
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
    // Track the composed signal across the WHOLE wire lifecycle: the fetch promise
    // resolves at response headers, while body-streaming aborts only reach the
    // dispatcher's onResponseError.
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
      // undici calls `dispatcher.dispatch(opts, handler)`; the casts only bridge
      // the type surface (RequestInit has no `dispatcher` member).
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
