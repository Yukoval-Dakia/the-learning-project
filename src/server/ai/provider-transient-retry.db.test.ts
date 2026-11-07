import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { type AgentFailureSubtype, AgentRunError } from '@/ai/agent-run-error';
import type { ProviderTransportEvidence, RequestSendState } from '@/ai/task-result';
import { ai_task_runs } from '@/db/schema';
import { resetDb, testDb } from '../../../tests/helpers/db';
import {
  type ProviderTransientRetryPolicy,
  planProviderTransientRetry,
  settledAttemptEvidence,
} from './provider-transient-retry';
import { createRunLifecycle } from './run-lifecycle';

const POLICY: ProviderTransientRetryPolicy = {
  maxRetries: 3,
  maxWaitMs: 180_000,
  baseDelayMs: 2_000,
};

const request = (
  send_state: RequestSendState,
  http_status?: number,
): {
  seq: number;
  loop: 'root';
  fetch_invoked_at: string;
  send_state: RequestSendState;
  http_status?: number;
} => ({
  seq: 0,
  loop: 'root',
  fetch_invoked_at: new Date().toISOString(),
  send_state,
  ...(http_status !== undefined ? { http_status } : {}),
});

const transport = (
  send_state: ProviderTransportEvidence['send_state'],
  requests: ReturnType<typeof request>[],
  byState?: Partial<Record<RequestSendState, number>>,
): ProviderTransportEvidence => ({
  v: 1,
  budget: { task_timeout_ms: 60_000 },
  lane: 'undici_agent',
  send_state,
  totals: {
    requests: requests.length,
    dispatches: requests.length,
    by_state: {
      not_sent: 0,
      sent_without_response: 0,
      response_received: 0,
      unknown: 0,
      in_flight: 0,
      ...byState,
    },
  },
  requests,
  requests_seen: requests.length,
  requests_dropped: 0,
  captured_at: new Date().toISOString(),
});

async function insertRun(input: {
  settled: boolean;
  costUsd?: number | null;
  costBasis?: string;
  costRef?: string;
  transport?: ProviderTransportEvidence;
}): Promise<string> {
  const id = createId();
  await testDb()
    .insert(ai_task_runs)
    .values({
      id,
      task_kind: 'QuestionAdmissionSolveTask',
      provider: 'opendesign',
      model: 'deepseek-v4.1-flash',
      input_hash: 'a'.repeat(64),
      status: input.settled ? 'failure' : 'running',
      usage_json: {
        inputTokens: 0,
        outputTokens: 0,
        ...(input.transport ? { transport: input.transport } : {}),
      },
      ...(input.costUsd !== undefined && input.costUsd !== null
        ? {
            cost_usd: input.costUsd,
            cost_basis: input.costBasis ?? (input.costUsd === 0 ? 'estimated' : 'reported'),
            cost_ref:
              input.costRef ??
              (input.costUsd === 0 ? 'unbilled-provider-rejection:test' : 'pricebook:test'),
          }
        : {}),
      started_at: new Date(),
      ...(input.settled ? { finished_at: new Date() } : {}),
    });
  return id;
}

const runError = (
  taskRunId: string,
  fields: Partial<{
    subtype: AgentFailureSubtype;
    apiErrorStatus: number | null;
    errors: string[];
    httpStatus: number;
    retryAfterMs: number;
    badGateway: boolean;
  }> = {},
) =>
  new AgentRunError({
    kind: 'QuestionAdmissionSolveTask',
    taskRunId,
    subtype: fields.subtype ?? 'error_during_execution',
    ...(fields.apiErrorStatus !== undefined ? { apiErrorStatus: fields.apiErrorStatus } : {}),
    errors: fields.errors ?? ['provider failed'],
    ...(fields.httpStatus !== undefined
      ? {
          providerFailure: {
            http_status: fields.httpStatus,
            ...(fields.retryAfterMs !== undefined ? { retry_after_ms: fields.retryAfterMs } : {}),
          },
        }
      : {}),
    ...(fields.badGateway === true
      ? { helpProviderFault: { kind: 'bad_gateway' as const, httpStatus: 502 as const } }
      : {}),
  });

interface Row {
  readonly name: string;
  readonly error?: ReturnType<typeof runError>;
  readonly errorStatus?: number | null;
  readonly errorBody?: string[];
  readonly boundStatus?: number;
  readonly badGateway?: boolean;
  readonly retryAfterMs?: number;
  readonly costUsd?: number | null | 'unset';
  readonly costRef?: string;
  readonly settled?: boolean;
  readonly transport?: ProviderTransportEvidence;
  readonly resend: boolean;
  readonly retryClass?: string;
  readonly delayMs?: number;
}

const rows: Row[] = [
  {
    name: 'bound 500 membership-entitlement rejection resends within the shared budget',
    boundStatus: 500,
    errorBody: ['[code=internal_error] failed to evaluate membership entitlement'],
    costUsd: 0,
    resend: true,
    retryClass: 'server_error',
  },
  {
    name: 'bound 503 billing-scope rejection resends when nothing billed',
    boundStatus: 503,
    errorBody: ['[code=workspace_billing_scope_unavailable] resolve Billing Scope: timeout'],
    costUsd: 0,
    resend: true,
    retryClass: 'server_error',
  },
  {
    name: 'bound 5xx Retry-After wins the delay',
    boundStatus: 503,
    retryAfterMs: 30_000,
    costUsd: 0,
    resend: true,
    retryClass: 'server_error',
    delayMs: 30_000,
  },
  {
    name: 'bound 5xx on an attempt that already billed stays terminal',
    boundStatus: 503,
    costUsd: 0.0009,
    resend: false,
  },
  {
    name: 'bound 5xx with unknown cost stays terminal',
    boundStatus: 500,
    costUsd: null,
    resend: false,
  },
  {
    name: 'a recorded zero without the unbilled receipt never resends (free-at-margin lane)',
    boundStatus: 500,
    costUsd: 0,
    costRef: 'anthropic-sub:contract',
    resend: false,
  },
  {
    name: 'a catalog zero without the unbilled receipt never resends',
    boundStatus: 500,
    costUsd: 0,
    costRef: 'pi-catalog:opencode-go/deepseek-v4.1-flash',
    resend: false,
  },
  {
    name: 'bound 502 resends as server_error without a help fault',
    boundStatus: 502,
    costUsd: 0,
    resend: true,
    retryClass: 'server_error',
  },
  {
    name: 'bound 504 resends as server_error',
    boundStatus: 504,
    costUsd: 0,
    resend: true,
    retryClass: 'server_error',
  },
  {
    name: 'a bound pi bad-gateway fault resends within budget',
    badGateway: true,
    costUsd: 0,
    resend: true,
    retryClass: 'bad_gateway',
  },
  {
    name: 'bound 429 congestion resends with its own hint',
    boundStatus: 429,
    retryAfterMs: 4_000,
    costUsd: 0,
    resend: true,
    retryClass: 'rate_limited',
    delayMs: 4_000,
  },
  {
    name: 'bound 429 carrying a provider quota signature never resends in-run',
    boundStatus: 429,
    errorBody: ['GoUsageLimitError: weekly usage limit reached, resets 2026-11-13'],
    costUsd: 0,
    resend: false,
  },
  {
    name: 'bound 408 request timeout resends',
    boundStatus: 408,
    costUsd: 0,
    resend: true,
    retryClass: 'request_rejected',
  },
  {
    name: 'bound 409 resends',
    boundStatus: 409,
    costUsd: 0,
    resend: true,
    retryClass: 'request_rejected',
  },
  { name: 'bound 400 stays permanent', boundStatus: 400, costUsd: 0, resend: false },
  { name: 'bound 401 stays permanent', boundStatus: 401, costUsd: 0, resend: false },
  { name: 'bound 404 stays permanent', boundStatus: 404, costUsd: 0, resend: false },
  { name: 'bound 413 stays permanent', boundStatus: 413, costUsd: 0, resend: false },
  {
    name: 'transport-proven not_sent resends',
    transport: transport('not_sent', [request('not_sent')], { not_sent: 1 }),
    costUsd: 0,
    resend: true,
    retryClass: 'not_sent',
  },
  {
    name: 'sent_without_response with no bound status never resends',
    transport: transport(
      'sent_without_response',
      [request('response_received', 200), request('sent_without_response')],
      { response_received: 1, sent_without_response: 1 },
    ),
    costUsd: 0,
    resend: false,
  },
  {
    name: 'a bound status on a provably zero-cost attempt still resends',
    boundStatus: 500,
    transport: transport('response_received', [request('response_received', 500)], {
      response_received: 1,
    }),
    costUsd: 0,
    resend: true,
    retryClass: 'server_error',
  },
  {
    name: 'unknown send state never resends',
    transport: transport('unknown', [request('unknown')], { unknown: 1 }),
    costUsd: 0,
    resend: false,
  },
  {
    name: 'an in-flight request never resends',
    transport: transport('unknown', [request('in_flight')], { in_flight: 1 }),
    costUsd: 0,
    resend: false,
  },
  {
    name: 'api_error_result with no bound status (connection class) never resends',
    errorStatus: null,
    costUsd: 0,
    resend: false,
  },
  {
    name: 'stream without a terminal never resends',
    error: runError('placeholder', { subtype: 'stream_no_terminal' }),
    costUsd: 0,
    resend: false,
  },
  {
    name: 'a still-running attempt never resends',
    boundStatus: 500,
    settled: false,
    costUsd: 0,
    resend: false,
  },
];

describe('planProviderTransientRetry — one table for every settled failure', () => {
  beforeEach(async () => {
    await resetDb();
  });

  for (const row of rows) {
    // @invariant data: a settled failure re-issues only a positively-rejected, provably zero-cost request — every other terminal shape stays terminal
    // @fails-if a bound 5xx/408/409 stops resending, a sent/unknown/paid request resends, or the recorded cost gate admits a non-zero attempt
    it(row.name, async () => {
      const taskRunId = await insertRun({
        settled: row.settled ?? true,
        ...(row.costUsd !== 'unset' ? { costUsd: row.costUsd ?? undefined } : {}),
        ...(row.costRef !== undefined ? { costRef: row.costRef } : {}),
        ...(row.transport ? { transport: row.transport } : {}),
      });
      const error =
        row.error !== undefined
          ? new AgentRunError({
              kind: 'QuestionAdmissionSolveTask',
              taskRunId,
              subtype: row.error.subtype,
              errors: row.error.errors,
            })
          : runError(taskRunId, {
              ...(row.errorStatus !== undefined ? { apiErrorStatus: row.errorStatus } : {}),
              ...(row.errorBody ? { errors: row.errorBody } : {}),
              ...(row.boundStatus !== undefined
                ? { httpStatus: row.boundStatus, retryAfterMs: row.retryAfterMs }
                : {}),
              ...(row.badGateway === true ? { badGateway: true } : {}),
            });
      const plan = await planProviderTransientRetry({
        db: testDb(),
        error,
        policy: POLICY,
        budget: { retries: 0, waitedMs: 0 },
      });
      if (!row.resend) {
        expect(plan).toBeUndefined();
        return;
      }
      expect(plan).toBeDefined();
      expect(plan?.verdict.class).toBe(row.retryClass);
      if (row.delayMs !== undefined) expect(plan?.delayMs).toBe(row.delayMs);
      else expect(plan?.delayMs).toBeGreaterThan(0);
    });
  }

  // @invariant data: the resend chain is bounded — retries and slept wait both stop at the configured policy
  // @fails-if a fourth resend is planned or a delay past the wait budget is taken
  it('the resend counter bounds the chain', async () => {
    const taskRunId = await insertRun({ settled: true, costUsd: 0 });
    const error = runError(taskRunId, { httpStatus: 500 });
    for (const retries of [0, 1, 2]) {
      const plan = await planProviderTransientRetry({
        db: testDb(),
        error,
        policy: POLICY,
        budget: { retries, waitedMs: 0 },
      });
      expect(plan).toBeDefined();
    }
    expect(
      await planProviderTransientRetry({
        db: testDb(),
        error,
        policy: POLICY,
        budget: { retries: 3, waitedMs: 0 },
      }),
    ).toBeUndefined();
    // The sleep budget likewise caps: a delay that cannot fit is not taken.
    expect(
      await planProviderTransientRetry({
        db: testDb(),
        error,
        policy: POLICY,
        budget: { retries: 0, waitedMs: POLICY.maxWaitMs - POLICY.baseDelayMs + 1 },
      }),
    ).toBeUndefined();
  });

  // @invariant data: the unbilled receipt the retry gate reads is the one the real lifecycle writes — an armed transport whose only request settled as a bound non-2xx persists estimated-0 cost with the unbilled-provider-rejection ref plus the transport snapshot
  // @fails-if finishFailure stops persisting the unbilled truth or transport evidence, or the gate stops reading the written row
  it('a real lifecycle settle writes the unbilled receipt the plan consumes', async () => {
    // Provider resolution requires only the key's presence — no wire call is made.
    const priorKey = process.env.OPENCODE_API_KEY;
    process.env.OPENCODE_API_KEY = 'test-key';
    const lifecycle = createRunLifecycle({
      db: testDb(),
      kind: 'QuestionAdmissionSolveTask',
      timeoutMs: 60_000,
      logScope: 'yuk2030-db-test',
    });
    try {
      await lifecycle.start({ question: 'write-side probe' });
      lifecycle.transportEvidence.noteArmed();
      lifecycle.transportEvidence.noteFetchLoop('root');
      const record = lifecycle.transportEvidence.beginFetch();
      lifecycle.transportEvidence.recordFetchSettled(record, 500);
      const boundError = new AgentRunError({
        kind: 'QuestionAdmissionSolveTask',
        taskRunId: lifecycle.taskRunId,
        subtype: 'api_error_result',
        apiErrorStatus: 500,
        errors: ['[code=internal_error] failed to evaluate membership entitlement'],
        providerFailure: { http_status: 500 },
      });
      const settled = await lifecycle.finishFailure(boundError);
      expect(settled).toBe(true);

      const [row] = await testDb()
        .select({
          cost_usd: ai_task_runs.cost_usd,
          cost_basis: ai_task_runs.cost_basis,
          cost_ref: ai_task_runs.cost_ref,
        })
        .from(ai_task_runs)
        .where(eq(ai_task_runs.id, lifecycle.taskRunId));
      expect(row?.cost_usd).toBe(0);
      expect(row?.cost_basis).toBe('estimated');
      expect(row?.cost_ref?.startsWith('unbilled-provider-rejection:')).toBe(true);

      const evidence = await settledAttemptEvidence(testDb(), lifecycle.taskRunId);
      expect(evidence.settled).toBe(true);
      expect(evidence.unbilled).toBe(true);
      expect(evidence.transport?.requests.at(-1)?.http_status).toBe(500);

      const plan = await planProviderTransientRetry({
        db: testDb(),
        error: boundError,
        policy: POLICY,
        budget: { retries: 0, waitedMs: 0 },
      });
      expect(plan?.verdict.class).toBe('server_error');
      expect(plan?.delayMs).toBeGreaterThan(0);
    } finally {
      lifecycle.dispose();
      if (priorKey === undefined) delete process.env.OPENCODE_API_KEY;
      else process.env.OPENCODE_API_KEY = priorKey;
    }
  });
});
