import type { Dispatcher } from 'undici';
import { Agent, fetch as undiciFetch } from 'undici';
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
 * still pending, or observed through a non-instrumented fetch stays
 * `unknown`/`in_flight`; a later request's `not_sent` never masks an earlier
 * request that did send.
 *
 * The scope of `send_state` is this attempt's provider model-request lane —
 * everything the pi drivers route through `options.fetch` (root loop, nested
 * subagent loops and SDK-internal retries all funnel through the same
 * instrumented fetch). Other lanes (e.g. the provider /models check) have
 * their own transports and are out of scope.
 */

export type TransportLane = 'undici_agent' | 'observer_fetch';
export type TransportSendState =
  | 'not_sent'
  | 'sent_without_response'
  | 'response_received'
  | 'unknown';
/** `in_flight` = the snapshot was taken while the request was still pending. */
export type RequestSendState = TransportSendState | 'in_flight';
export type TransportTimeoutLayer =
  | 'connect'
  | 'headers'
  | 'body'
  | 'sdk'
  /**
   * The fetch's composed AbortSignal ended the request. Caller deadline,
   * lifecycle task abort and the SDK's own whole-request timer all collapse
   * into this one observable — attribute the culprit via the budget receipt
   * fields (execution_timeout_ms / sdk_timeout_ms / caller_deadline_at).
   */
  | 'signal';

export interface TransportFailureEvidence {
  readonly name: string;
  readonly code?: string;
  /** Sanitized (secrets + auth patterns) and UTF-8 truncated. */
  readonly message: string;
  readonly cause?: readonly TransportFailureEvidence[];
}

export interface ProviderRequestEvidence {
  readonly seq: number;
  /** Which transport actually carried this call. */
  readonly lane: TransportLane;
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
  readonly signal_aborted?: boolean;
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
  /** Run-level rollup — see module docstring; never masks an earlier send. */
  readonly send_state: TransportSendState;
  readonly requests: readonly ProviderRequestEvidence[];
  readonly requests_seen: number;
  readonly requests_dropped: number;
  readonly captured_at: string;
}

const MAX_REQUEST_RECORDS = 32;
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
  lane: TransportLane;
  fetchInvokedAt: string;
  requestStartedAt?: string;
  requestSentAt?: string;
  responseStartedAt?: string;
  responseHeadersAt?: string;
  endedAt?: string;
  fetchSettledAt?: string;
  fetchOutcome?: 'response' | 'failure';
  httpStatus?: number;
  dispatches: number;
  wireError?: TransportFailureEvidence;
  fetchError?: TransportFailureEvidence;
  signalAborted?: boolean;
}

const now = (): string => new Date().toISOString();

/**
 * The platform fetch captured at module load. Node's global fetch is a JS
 * wrapper over the built-in undici, so it cannot be identified by
 * `[native code]` stringification — identity is the only reliable marker.
 * An observer installed BEFORE this module loads is captured as the platform
 * (e.g. an offline test guard that also stubs `net.Socket.connect`): the
 * undici lane then applies and the lower-level stub still denies the socket.
 * Observers installed at call-time (the usual `vi.stubGlobal('fetch', ...)`
 * pattern) differ from the captured value and take the `observer_fetch` lane —
 * the same precedence the lane always had when it passed the global through.
 */
const platformFetch = globalThis.fetch;

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
  private seq = 0;
  private armedLane: TransportLane | undefined;

  constructor(init: ProviderTransportCollectorInit) {
    this.budget = {
      task_timeout_ms: init.taskTimeoutMs,
      ...(init.timeoutSource !== undefined ? { timeout_source: init.timeoutSource } : {}),
      ...(init.callerDeadlineAt !== undefined
        ? { caller_deadline_at: new Date(init.callerDeadlineAt).toISOString() }
        : {}),
    };
  }

  /** Credentials to redact inside failure messages; set by the fetch factory. */
  setSecrets(secrets: readonly string[]): void {
    this.secrets = secrets;
  }

  /** The attempt's fetch was built — the provider lane is armed. */
  noteArmed(lane: TransportLane): void {
    this.armedLane ??= lane;
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

  /** The undici timers actually installed on the attempt's dispatcher. */
  noteTransportTimers(input: {
    connectTimeoutMs: number;
    headersTimeoutMs: number;
    bodyTimeoutMs: number;
    marginMs?: number;
  }): void {
    this.budget.connect_timeout_ms = input.connectTimeoutMs;
    this.budget.headers_timeout_ms = input.headersTimeoutMs;
    this.budget.body_timeout_ms = input.bodyTimeoutMs;
    if (input.marginMs !== undefined) this.budget.http_margin_ms = input.marginMs;
  }

  beginFetch(lane: TransportLane): MutableRequestRecord {
    this.requestsSeen += 1;
    const record: MutableRequestRecord = {
      seq: this.seq,
      lane,
      fetchInvokedAt: now(),
      dispatches: 0,
    };
    this.seq += 1;
    if (this.records.length < MAX_REQUEST_RECORDS) {
      this.records.push(record);
    } else {
      this.requestsDropped += 1;
    }
    return record;
  }

  recordFetchSettled(record: MutableRequestRecord, status: number): void {
    record.fetchSettledAt = now();
    record.fetchOutcome = 'response';
    record.httpStatus = status;
  }

  recordFetchFailure(
    record: MutableRequestRecord,
    error: unknown,
    signal?: AbortSignal | null,
  ): void {
    record.fetchSettledAt = now();
    record.fetchOutcome = 'failure';
    record.fetchError = this.captureError(error);
    record.signalAborted = signal?.aborted === true;
  }

  /** Bounded, sanitized {name, code, message, cause} — never headers/key/body. */
  captureError(error: unknown): TransportFailureEvidence {
    return failureEvidence(error, { secrets: this.secrets });
  }

  private requestSendState(record: MutableRequestRecord): RequestSendState {
    if (record.responseStartedAt !== undefined || record.responseHeadersAt !== undefined) {
      return 'response_received';
    }
    if (record.requestSentAt !== undefined) return 'sent_without_response';
    if (record.requestStartedAt !== undefined) {
      // Writing began but never completed — a partial send is possible.
      return 'unknown';
    }
    if (record.endedAt !== undefined && record.lane === 'undici_agent') {
      // Our dispatcher settled the request before it ever began a socket
      // write — connect/queue failure: positive not_sent evidence.
      return 'not_sent';
    }
    if (record.fetchSettledAt !== undefined) {
      if (record.lane === 'observer_fetch') {
        // A resolved observer fetch means the caller saw a response; a
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
      const timeoutLayer = classifyTimeoutLayer(error, record.signalAborted);
      return {
        seq: record.seq,
        lane: record.lane,
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
        send_state: this.requestSendState(record),
        ...(timeoutLayer !== undefined ? { timeout_layer: timeoutLayer } : {}),
        ...(record.signalAborted === true ? { signal_aborted: true } : {}),
        ...(error !== undefined ? { error } : {}),
      };
    });
    const states = requests.map((r) => r.send_state);
    const sendState: TransportSendState =
      states.length === 0
        ? 'not_sent'
        : states.some((s) => s === 'response_received')
          ? 'response_received'
          : states.some((s) => s === 'sent_without_response')
            ? 'sent_without_response'
            : states.every((s) => s === 'not_sent')
              ? 'not_sent'
              : 'unknown';
    const lanes = new Set(requests.map((r) => r.lane));
    return {
      v: 1,
      budget: this.budget,
      lane:
        lanes.size === 0
          ? this.armedLane === undefined
            ? 'none'
            : this.armedLane
          : lanes.size === 1
            ? [...lanes][0]
            : 'mixed',
      send_state: sendState,
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
  signalAborted?: boolean,
): TransportTimeoutLayer | undefined {
  const codes = errorCodes(error);
  if (codes.has('UND_ERR_CONNECT_TIMEOUT')) return 'connect';
  if (codes.has('UND_ERR_HEADERS_TIMEOUT')) return 'headers';
  if (codes.has('UND_ERR_BODY_TIMEOUT')) return 'body';
  // The OpenAI/Anthropic SDK whole-request timer wraps its abort in
  // APIConnectionTimeoutError ("Request timed out.") — identifiable by name
  // because undici only sees the composed signal fire.
  if (error !== undefined && containsName(error, 'APIConnectionTimeoutError')) return 'sdk';
  if (codes.has('UND_ERR_ABORTED') || signalAborted === true) return 'signal';
  return undefined;
}

function errorCodes(error: TransportFailureEvidence | undefined): Set<string> {
  const codes = new Set<string>();
  let current: TransportFailureEvidence | undefined = error;
  while (current !== undefined) {
    if (current.code !== undefined) codes.add(current.code);
    current = current.cause?.[0];
  }
  return codes;
}

function containsName(error: TransportFailureEvidence, name: string): boolean {
  let current: TransportFailureEvidence | undefined = error;
  while (current !== undefined) {
    if (current.name === name) return true;
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
  const code =
    error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? error.code
      : undefined;
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
 * Per-`dispatch()` wrapper around the attempt's Agent. One fetch call maps to
 * one record, so concurrent fetches can never cross-pollinate evidence.
 */
class ObservedDispatcher {
  constructor(
    private readonly agent: Agent,
    private readonly record: MutableRequestRecord,
    private readonly captureError: (error: unknown) => TransportFailureEvidence,
  ) {}

  dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    const record = this.record;
    record.dispatches += 1;
    const observed: Dispatcher.DispatchHandler = {
      onRequestStart: (controller, context) => {
        record.requestStartedAt ??= now();
        handler.onRequestStart?.(controller, context);
      },
      onRequestUpgrade: (controller, statusCode, headers, socket) =>
        handler.onRequestUpgrade?.(controller, statusCode, headers, socket),
      onRequestSent: () => {
        record.requestSentAt ??= now();
        handler.onRequestSent?.();
      },
      onResponseStarted: () => {
        record.responseStartedAt ??= now();
        handler.onResponseStarted?.();
      },
      onResponseStart: (controller, statusCode, headers, statusMessage) => {
        record.responseHeadersAt ??= now();
        record.httpStatus = statusCode;
        handler.onResponseStart?.(controller, statusCode, headers, statusMessage);
      },
      onResponseData: (controller, chunk) => handler.onResponseData?.(controller, chunk),
      onResponseEnd: (controller, trailers) => {
        record.endedAt ??= now();
        handler.onResponseEnd?.(controller, trailers);
      },
      onResponseError: (controller, error) => {
        record.wireError ??= this.captureError(error);
        record.endedAt ??= now();
        handler.onResponseError?.(controller, error);
      },
      onBodySent: (chunk) => handler.onBodySent?.(chunk),
    };
    return this.agent.dispatch(options, observed);
  }
}

export interface BudgetedProviderFetch {
  readonly fetch: typeof fetch;
  readonly close: () => Promise<void>;
}

/**
 * Fetch for one attempt's provider lane. Always armed with explicit
 * connect/headers/body timers on an npm-undici Agent — `httpTimeoutMs` is the
 * single budget-derived value the runner computed. When an observer has
 * replaced `globalThis.fetch` (test stubs, instrumentation wrappers), that
 * fetch wins instead — the same precedence the lane always had when it passed
 * the global through verbatim — and the record is marked `observer_fetch` so
 * missing wire milestones read as `unknown`, never fabricated `not_sent`.
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
  collector?.noteArmed('undici_agent');
  collector?.noteTransportTimers({
    connectTimeoutMs: input.httpTimeoutMs,
    headersTimeoutMs: input.httpTimeoutMs,
    bodyTimeoutMs: input.httpTimeoutMs,
    ...(input.marginMs !== undefined ? { marginMs: input.marginMs } : {}),
  });
  const fetchImpl: typeof fetch = async (fetchInput, init) => {
    const base = globalThis.fetch;
    const lane: TransportLane = base === platformFetch ? 'undici_agent' : 'observer_fetch';
    const record = collector?.beginFetch(lane);
    try {
      const response =
        lane === 'undici_agent'
          ? ((await undiciFetch(fetchInput as Parameters<typeof undiciFetch>[0], {
              ...(init as object),
              // undici calls `dispatcher.dispatch(opts, handler)` — a plain
              // object satisfies the call; the cast only bridges the type.
              dispatcher: (record !== undefined && collector !== undefined
                ? new ObservedDispatcher(agent, record, (e) => collector.captureError(e))
                : agent) as unknown as Dispatcher,
            })) as unknown as Response)
          : await base(fetchInput, init);
      if (record !== undefined) collector?.recordFetchSettled(record, response.status);
      return response;
    } catch (error) {
      if (record !== undefined) collector?.recordFetchFailure(record, error, init?.signal);
      throw error;
    }
  };
  return {
    fetch: fetchImpl,
    close: () => agent.close(),
  };
}
