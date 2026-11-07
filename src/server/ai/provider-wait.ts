// Job-level provider-wait contract (YUK-2030). When a background job's paid call
// dies to a provable transient provider rejection (bound 5xx / 429 / 408-409 /
// not_sent — never quota exhaustion, never an uncertain outcome), the job asks
// its scheduler to wait for route recovery instead of landing terminal. The
// scheduler owns the wait budget; the job only proves eligibility.
//
// Gates (fail closed on every one): AgentRunError → providerTransientVerdict
// resendable class → settled unbilled-rejection evidence. A billed or unknown
// attempt can never enter a wait — the send may have been paid for.
//
// The output key `provider_wait` is the durable ask a DAG member leaves on its
// completed pg-boss job; the orchestrator reads it and re-delivers the node with
// `startAfter`. Non-DAG jobs (note_generate, prepare_intervention, admission
// stages) carry their own wait receipts and rides this ladder for parity.

import { AgentRunError } from '@/ai/agent-run-error';
import {
  type ProviderTransientClass,
  providerTransientClassForStatus,
  providerTransientResendable,
  providerTransientVerdict,
} from '@/ai/provider-failure';
import type { ProviderTransportEvidence } from '@/ai/task-result';
import type { Db } from '@/db/client';
import { settledAttemptEvidence } from './provider-transient-retry';

/** Job-level provider-wait backoff: 5/15/30/60 min then 60 min flat. */
const PROVIDER_WAIT_LADDER_MS = [5, 15, 30, 60].map((m) => m * 60_000);

/**
 * Wait budget, anti-loop bound only. Worst case ≈ 5+15+30+60×5 ≈ 6.5 h — well
 * above a one-hour provider outage and inside the 7 h DAG node timeout.
 */
export const PROVIDER_WAIT_MAX = 8;

/**
 * Classes eligible for a job-level wait. `quota_exhausted` is deliberately out:
 * quota is a day-scale budget with its own admission waiting path, not a route
 * outage this wait exists to bridge.
 */
export function providerWaitEligible(cls: ProviderTransientClass): boolean {
  return providerTransientResendable(cls);
}

export function providerWaitDelayMs(waits: number): number {
  return PROVIDER_WAIT_LADDER_MS[
    Math.min(Math.max(waits - 1, 0), PROVIDER_WAIT_LADDER_MS.length - 1)
  ];
}

export interface ProviderWaitDecision {
  readonly retryClass: ProviderTransientClass;
  /** task_run_id whose settled row carried the unbilled-rejection receipt. */
  readonly evidenceRef: string;
}

/**
 * Decide whether `error` may enter a provider wait. Only positively proven
 * transient provider rejections qualify: verdict resendable AND the settled
 * attempt row carries cost_basis='estimated' + cost_usd=0 + an
 * `unbilled-provider-rejection:` ref. Uncertain outcomes, paid attempts, quota
 * exhaustion and non-provider failures return null — those land terminal.
 */
export async function planJobProviderWait(
  db: Db,
  error: unknown,
): Promise<ProviderWaitDecision | null> {
  if (!(error instanceof AgentRunError) || !error.taskRunId) return null;
  const verdict = providerTransientVerdict({ error });
  if (!verdict || !providerWaitEligible(verdict.class)) return null;
  const evidence = await settledAttemptEvidence(db, error.taskRunId);
  if (!evidence.settled || !evidence.unbilled) return null;
  return { retryClass: verdict.class, evidenceRef: error.taskRunId };
}

/**
 * Row-driven variant for callers that lost the error object (e.g. the
 * `[streamTask]` marker carries only task_run_id). The transport snapshot is
 * the bound-status source — the same third leg `boundTerminalHttpStatus` uses:
 * a terminal root request with a ≥400 status and zero uncertain wire states,
 * or a whole-snapshot not_sent. Anything else stays unclassified → null.
 */
export async function planJobProviderWaitForRun(
  db: Db,
  taskRunId: string,
  input: { errorEvidence?: readonly string[] } = {},
): Promise<ProviderWaitDecision | null> {
  const evidence = await settledAttemptEvidence(db, taskRunId);
  if (!evidence.settled || !evidence.unbilled) return null;
  const cls = providerWaitClassForTransport(evidence.transport, {
    errorEvidence: [...(input.errorEvidence ?? []), evidence.errorMessage ?? ''],
  });
  if (cls === undefined || !providerWaitEligible(cls)) return null;
  return { retryClass: cls, evidenceRef: taskRunId };
}

/** Transport-only classification, mirroring boundTerminalHttpStatus's last leg. */
function providerWaitClassForTransport(
  transport: ProviderTransportEvidence | undefined,
  input: { errorEvidence?: readonly string[] } = {},
): ProviderTransientClass | undefined {
  if (!transport) return undefined;
  const last = transport.requests.at(-1);
  if (
    last?.loop === 'root' &&
    last.send_state === 'response_received' &&
    last.http_status != null &&
    last.http_status >= 400 &&
    transport.totals.by_state.in_flight === 0 &&
    transport.totals.by_state.unknown === 0 &&
    transport.totals.by_state.sent_without_response === 0
  ) {
    return providerTransientClassForStatus({
      httpStatus: last.http_status,
      errorEvidence: input.errorEvidence,
    })?.class;
  }
  if (transport.send_state === 'not_sent') return 'not_sent';
  return undefined;
}

export const PROVIDER_WAIT_OUTPUT_KEY = 'provider_wait';

/** Marker a DAG member returns inside its job output to ask for a wait. */
export function providerWaitOutput(input: {
  retryClass: string;
  detail: string;
}): Record<string, unknown> {
  return {
    [PROVIDER_WAIT_OUTPUT_KEY]: {
      retry_class: input.retryClass,
      detail: input.detail.slice(0, 500),
    },
  };
}

/** Parse a job output's provider-wait marker; invalid shapes are ignored. */
export function readProviderWaitRequest(
  output: unknown,
): { retryClass: string; detail: string } | undefined {
  if (output === null || typeof output !== 'object' || Array.isArray(output)) return undefined;
  const wait = (output as Record<string, unknown>)[PROVIDER_WAIT_OUTPUT_KEY];
  if (wait === null || typeof wait !== 'object' || Array.isArray(wait)) return undefined;
  const retryClass = (wait as Record<string, unknown>).retry_class;
  if (typeof retryClass !== 'string' || retryClass.length === 0) return undefined;
  const detail = (wait as Record<string, unknown>).detail;
  return {
    retryClass,
    detail: typeof detail === 'string' ? detail : '',
  };
}
