import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ProviderAttemptResumeConflictError,
  TencentSubmitInProgressError,
  executeTencentOcrSubmit,
  extractionPageOperationId,
} from '@/capabilities/ingestion/server/provider-attempts';
import type { DescribeResponse } from '@/capabilities/ingestion/server/tencent_mark';
import { RetryableError } from '@/core/schema/structured_question';
import { db } from '@/db/client';
import { job_events, learning_session, provider_attempt, question_block } from '@/db/schema';
import { createImageR2, seedIngestionSession } from '@/server/session/ingestion-test-support';
import tencentDone from '../../../../tests/fixtures/tencent_mark_agent_cloze_sample.json';
import { resetDb } from '../../../../tests/helpers/db';
import { buildTencentOcrHandler } from './tencent_ocr_extract';

function structureResult() {
  return {
    questions: [
      {
        id: 'tencent-resumed-question',
        role: 'standalone' as const,
        prompt_text: 'resumed aggregate projection',
        source: 'vlm_structure' as const,
      },
    ],
    layout_quality: 'structured' as const,
    extraction_confidence: 0.84,
    warnings: [],
  };
}

function legacySubmitAttempt(pageOperationId: string, jobId: string, startedAt: Date) {
  return {
    attempt_id: randomUUID(),
    operation_id: pageOperationId,
    attempt_kind: 'wire',
    provider: 'tencent',
    model: 'QuestionMarkAgent',
    lane_id: 'tencent.question-mark-agent',
    protocol: 'http',
    endpoint_class: 'tencent.question-mark-agent.submit',
    caller: 'worker',
    operation_kind: 'ocr_page_submit',
    external_request_id: jobId,
    terminal_status: 'succeeded',
    terminal_reason: 'provider_response_accepted',
    wire_count: 1,
    usage_json: {
      basis: 'unknown' as const,
      unit: 'tokens',
      input: null,
      output: null,
      total: null,
      source: 'provider_response_absent',
    },
    cost_basis: 'unknown',
    cost_amount: null,
    cost_currency: 'CNY',
    cost_source: 'provider_cost_absent',
    started_at: startedAt,
    provider_start_reserved_at: startedAt,
    finished_at: startedAt,
  };
}

beforeEach(async () => {
  vi.stubEnv('AI_PROVIDER_ATTEMPT_ADMISSION_MODE', 'observe');
  vi.stubEnv(
    'AI_PROVIDER_ATTEMPT_ADMISSION_POLICIES_JSON',
    JSON.stringify({
      'tencent.question-mark-agent': {
        maxConcurrentAttempts: 100,
        maxAttemptStartsPerMinute: 1000,
      },
    }),
  );
  await resetDb();
});
afterEach(() => vi.unstubAllEnvs());

describe('Tencent OCR provider-attempt resume', () => {
  it('does not rethrow an off-mode external-id persistence failure or duplicate Submit on retry', async () => {
    vi.stubEnv('AI_PROVIDER_ATTEMPT_ADMISSION_MODE', 'off');
    vi.stubEnv('AI_PROVIDER_ATTEMPT_ADMISSION_POLICIES_JSON', '{stale malformed rollback config');
    const pageOperationId = extractionPageOperationId({
      canonicalOperationId: 'post-wire-control-plane-failure',
      bossJobId: 'post-wire-control-plane-failure',
      pageIndex: 0,
    });
    const submit = vi.fn(async () => 'accepted-without-persisted-id');
    await db.execute(sql`CREATE OR REPLACE FUNCTION yuk855_reject_external_request_id()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.external_request_id IS NULL AND NEW.external_request_id IS NOT NULL THEN
          RAISE EXCEPTION 'simulated external request id persistence failure';
        END IF;
        RETURN NEW;
      END
      $$`);
    await db.execute(sql`CREATE TRIGGER yuk855_reject_external_request_id
      BEFORE UPDATE OF external_request_id ON provider_attempt
      FOR EACH ROW EXECUTE FUNCTION yuk855_reject_external_request_id()`);

    try {
      const firstDelivery = { retryCount: 0, startedOn: new Date() };
      const retryDelivery = { retryCount: 1, startedOn: new Date(Date.now() + 1_000) };
      const input = {
        db,
        pageOperationId,
        deliveryStartedOn: firstDelivery.startedOn,
        params: { ImageBase64: 'seed' },
        submit,
      };

      await expect(executeTencentOcrSubmit(input)).resolves.toBe('accepted-without-persisted-id');
      await expect(
        executeTencentOcrSubmit({
          ...input,
          deliveryStartedOn: retryDelivery.startedOn,
        }),
      ).rejects.toBeInstanceOf(TencentSubmitInProgressError);
      expect(submit).toHaveBeenCalledOnce();
    } finally {
      await db.execute(
        sql`DROP TRIGGER IF EXISTS yuk855_reject_external_request_id ON provider_attempt`,
      );
      await db.execute(sql`DROP FUNCTION IF EXISTS yuk855_reject_external_request_id()`);
    }
  });

  it('treats a callback throw after Submit reservation as ambiguous across retry generations', async () => {
    vi.stubEnv('AI_PROVIDER_ATTEMPT_ADMISSION_MODE', 'off');
    const pageOperationId = extractionPageOperationId({
      canonicalOperationId: 'failed-submit-retry',
      bossJobId: 'failed-submit-retry',
      pageIndex: 0,
    });
    const submitError = new Error('provider rejected Submit before acceptance');
    const submit = vi.fn().mockRejectedValueOnce(submitError);
    const firstInput = {
      db,
      pageOperationId,
      deliveryStartedOn: new Date(),
      params: { ImageBase64: 'seed' },
      submit,
    };

    await expect(executeTencentOcrSubmit(firstInput)).rejects.toBe(submitError);
    await expect(
      executeTencentOcrSubmit({
        ...firstInput,
        deliveryStartedOn: new Date(Date.now() + 1_000),
      }),
    ).rejects.toBeInstanceOf(TencentSubmitInProgressError);
    expect(submit).toHaveBeenCalledOnce();
    const attempts = await db
      .select()
      .from(provider_attempt)
      .where(eq(provider_attempt.operation_id, pageOperationId));
    expect(attempts).toEqual([
      expect.objectContaining({
        terminal_status: 'failed',
        wire_count: 1,
        external_request_id: null,
      }),
    ]);
  });

  it('resumes the saved JobId after termination without a second Submit', async () => {
    // Given: Tencent accepted Submit and the worker terminates after persisting its JobId.
    const { sessionId, operationId } = await seedIngestionSession(1);
    const submitFn = vi.fn(async () => 'saved-job-id');
    const describeFn = vi.fn(
      async (_jobId: string): Promise<DescribeResponse> => ({
        ...tencentDone,
        JobStatus: 'DONE',
      }),
    );
    const firstHandler = buildTencentOcrHandler({
      db,
      r2: await createImageR2(),
      engine: 'tencent',
      submitFn,
      describeFn,
      runStructureFn: vi.fn(async () => structureResult()),
      afterTencentJobSaved: async () => {
        throw new RetryableError('simulated process termination');
      },
    });
    const job = {
      id: 'canonical-crash-job',
      data: { sessionId, operationId },
      retryCount: 0,
      retryLimit: 2,
      startedOn: new Date('2026-08-09T00:00:00.000Z'),
    };

    // When: a separately built handler receives the same pg-boss job again.
    await expect(firstHandler([job] as never)).rejects.toThrow('simulated process termination');
    const saved = await db
      .select()
      .from(provider_attempt)
      .where(eq(provider_attempt.external_request_id, 'saved-job-id'));
    const failedEvents = await db
      .select()
      .from(job_events)
      .where(eq(job_events.business_id, operationId));
    expect(saved).toHaveLength(1);
    expect(describeFn).not.toHaveBeenCalled();
    expect(failedEvents.some((event) => event.event_type === 'operation.failed')).toBe(false);
    const secondHandler = buildTencentOcrHandler({
      db,
      r2: await createImageR2(),
      engine: 'tencent',
      submitFn,
      describeFn,
      runStructureFn: vi.fn(async () => structureResult()),
    });
    await secondHandler([{ ...job, retryCount: 1 }] as never);

    // Then: only the saved JobId is polled, and new truth remains unknown while
    // provider-attempt truth remains unknown rather than fabricating zero cost.
    expect(submitFn).toHaveBeenCalledOnce();
    expect(describeFn).toHaveBeenCalledWith('saved-job-id');
    const session = await db
      .select({ status: learning_session.status })
      .from(learning_session)
      .where(eq(learning_session.id, sessionId));
    expect(session[0]?.status).toBe('extracted');
    const attempts = await db
      .select()
      .from(provider_attempt)
      .where(eq(provider_attempt.provider, 'tencent'));
    expect(new Set(attempts.map((attempt) => attempt.lane_id))).toEqual(
      new Set(['tencent.question-mark-agent']),
    );
    expect(new Set(attempts.map((attempt) => attempt.protocol))).toEqual(new Set(['http']));
    expect(new Set(attempts.map((attempt) => attempt.endpoint_class))).toEqual(
      new Set(['tencent.question-mark-agent.submit', 'tencent.question-mark-agent.describe']),
    );
    expect(attempts.every((attempt) => attempt.cost_basis === 'unknown')).toBe(true);
    expect(attempts.every((attempt) => attempt.usage_json?.basis === 'unknown')).toBe(true);
  });

  it('keeps poll timeout resumable and polls the same JobId on redelivery', async () => {
    // Given: a legacy payload submits once, then every Describe stays non-terminal.
    const { sessionId } = await seedIngestionSession(1);
    const submitFn = vi.fn(async () => 'timeout-job-id');
    let providerDone = false;
    const describeFn = vi.fn(
      async (_jobId: string): Promise<DescribeResponse> =>
        providerDone ? { ...tencentDone, JobStatus: 'DONE' } : { JobStatus: 'WAIT' },
    );
    const job = {
      id: 'legacy-stable-boss-anchor',
      data: { sessionId },
      retryCount: 0,
      retryLimit: 2,
      startedOn: new Date('2026-08-09T00:00:00.000Z'),
    };
    const firstHandler = buildTencentOcrHandler({
      db,
      r2: await createImageR2(),
      engine: 'tencent',
      submitFn,
      describeFn,
      tencentPollOptions: { intervalMs: 1, timeoutMs: 5 },
      runStructureFn: vi.fn(async () => structureResult()),
    });

    // When: local polling times out and pg-boss redelivers the old {sessionId} payload.
    await expect(firstHandler([job] as never)).rejects.toThrow(/poll timeout/);
    const afterTimeout = await db
      .select({ status: learning_session.status })
      .from(learning_session)
      .where(eq(learning_session.id, sessionId));
    expect(afterTimeout[0]?.status).toBe('extracting');
    providerDone = true;
    const secondHandler = buildTencentOcrHandler({
      db,
      r2: await createImageR2(),
      engine: 'tencent',
      submitFn,
      describeFn,
      runStructureFn: vi.fn(async () => structureResult()),
    });
    await secondHandler([{ ...job, retryCount: 1 }] as never);

    // Then: legacy anchoring remains stable and no incomplete question block was published.
    expect(submitFn).toHaveBeenCalledOnce();
    expect(describeFn.mock.calls.every(([jobId]) => jobId === 'timeout-job-id')).toBe(true);
    const blocks = await db
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, sessionId));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.structured?.prompt_text).toBe('resumed aggregate projection');
  });

  it('treats provider FAIL as distinct and terminal', async () => {
    // Given: Tencent accepts a job but reports provider-terminal FAIL on Describe.
    const { sessionId, operationId } = await seedIngestionSession(1);
    const submitFn = vi.fn(async () => 'failed-provider-job');
    const describeFn = vi.fn(
      async (_jobId: string): Promise<DescribeResponse> => ({
        JobStatus: 'FAIL',
        JobErrorMsg: 'provider rejected document',
        RequestId: 'describe-fail-request',
      }),
    );
    const handler = buildTencentOcrHandler({
      db,
      r2: await createImageR2(),
      engine: 'tencent',
      submitFn,
      describeFn,
    });

    // When: the terminal provider response is handled.
    await expect(
      handler([
        {
          id: 'provider-fail-job',
          data: { sessionId, operationId },
          retryCount: 0,
          retryLimit: 2,
          startedOn: new Date('2026-08-09T00:00:00.000Z'),
        },
      ] as never),
    ).rejects.toThrow(/provider rejected document/);

    // Then: the session is final-failed and the Describe wire attempt records provider failure.
    const session = await db
      .select({ status: learning_session.status })
      .from(learning_session)
      .where(eq(learning_session.id, sessionId));
    expect(session[0]?.status).toBe('failed');
    const attempts = await db
      .select()
      .from(provider_attempt)
      .where(eq(provider_attempt.external_request_id, 'describe-fail-request'));
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.terminal_status).toBe('failed');
    expect(attempts[0]?.terminal_reason).toBe('provider_job_failed');
  });

  it('finalizes a retryable error when pg-boss reaches the retry limit', async () => {
    // Given: the final canonical delivery saves a JobId and then encounters a retryable crash.
    const { sessionId, operationId } = await seedIngestionSession(1);
    const handler = buildTencentOcrHandler({
      db,
      r2: await createImageR2(),
      engine: 'tencent',
      submitFn: vi.fn(async () => 'final-delivery-job'),
      describeFn: vi.fn(),
      afterTencentJobSaved: async () => {
        throw new RetryableError('final delivery exhausted');
      },
    });

    // When: retryCount equals retryLimit and the handler rejects for pg-boss/DLQ handling.
    await expect(
      handler([
        {
          id: 'final-delivery-boss-job',
          data: { sessionId, operationId },
          retryCount: 2,
          retryLimit: 2,
          startedOn: new Date('2026-08-09T00:00:00.000Z'),
        },
      ] as never),
    ).rejects.toThrow('final delivery exhausted');

    // Then: product state and the canonical operation are terminal-failed.
    const session = await db
      .select({ status: learning_session.status })
      .from(learning_session)
      .where(eq(learning_session.id, sessionId));
    expect(session[0]?.status).toBe('failed');
    const operationEvents = await db
      .select()
      .from(job_events)
      .where(eq(job_events.business_id, operationId));
    expect(operationEvents.some((event) => event.event_type === 'operation.failed')).toBe(true);
  });

  it('propagates a saved JobId invariant conflict without recovery wire calls', async () => {
    // Given: two historical Submit attempts persisted different JobIds for one canonical page.
    const { sessionId, operationId } = await seedIngestionSession(1);
    const pageOperationId = extractionPageOperationId({
      canonicalOperationId: operationId,
      bossJobId: 'conflict-handler-job',
      pageIndex: 0,
    });
    await db
      .insert(provider_attempt)
      .values([
        legacySubmitAttempt(
          pageOperationId,
          'historical-job-a',
          new Date('2026-08-09T00:00:00.000Z'),
        ),
        legacySubmitAttempt(
          pageOperationId,
          'historical-job-b',
          new Date('2026-08-09T00:01:00.000Z'),
        ),
      ]);
    const recoverySubmit = vi.fn(async () => 'must-not-submit');
    const recoveryDescribe = vi.fn(async (): Promise<DescribeResponse> => ({ JobStatus: 'DONE' }));
    const handler = buildTencentOcrHandler({
      db,
      r2: await createImageR2(),
      engine: 'tencent',
      submitFn: recoverySubmit,
      describeFn: recoveryDescribe,
    });

    // When: the handler reaches lookup for that page.
    const rejection = handler([
      {
        id: 'conflict-handler-job',
        data: { sessionId, operationId },
        retryCount: 0,
        retryLimit: 2,
      },
    ] as never);

    // Then: the original invariant error propagates and no recovery wire is attempted.
    await expect(rejection).rejects.toBeInstanceOf(ProviderAttemptResumeConflictError);
    expect(recoverySubmit).not.toHaveBeenCalled();
    expect(recoveryDescribe).not.toHaveBeenCalled();
  });
});
