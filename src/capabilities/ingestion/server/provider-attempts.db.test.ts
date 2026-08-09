import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProviderRequestIdentity } from '@/core/schema/provider-attempt';
import { type Db, db } from '@/db/client';
import * as schema from '@/db/schema';
import { provider_attempt, provider_attempt_admission } from '@/db/schema';
import { createProviderAttemptLifecycle } from '@/server/ai/provider-attempt-lifecycle';
import { providerOperationIdForInvocation } from '@/server/ai/provider-attempt-runtime';
import { resetDb } from '../../../../tests/helpers/db';
import {
  ProviderAttemptLifecycleError,
  ProviderAttemptResumeConflictError,
  TencentSubmitInProgressError,
  executeTencentOcrSubmit,
  extractionPageOperationId,
} from './provider-attempts';

async function closedDb(): Promise<Db> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL not set');
  const client = postgres(url, { max: 1 });
  const handle = drizzle(client, { schema });
  await client.end();
  return handle;
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

describe('ingestion provider-attempt resume helpers', () => {
  it.each(['off', 'observe'] as const)(
    'fails open from a %s history preflight outage and calls Submit once',
    async (mode) => {
      vi.stubEnv('AI_PROVIDER_ATTEMPT_ADMISSION_MODE', mode);
      if (mode === 'off') {
        vi.stubEnv('AI_PROVIDER_ATTEMPT_ADMISSION_POLICIES_JSON', '{stale malformed rollback');
      }
      const submit = vi.fn(async () => `${mode}-job-id`);

      await expect(
        executeTencentOcrSubmit({
          db: await closedDb(),
          pageOperationId: extractionPageOperationId({
            canonicalOperationId: `${mode}-closed-db`,
            bossJobId: `${mode}-closed-db`,
            pageIndex: 0,
          }),
          bossJobId: `${mode}-closed-db`,
          deliveryRetryCount: 0,
          deliveryStartedOn: new Date(),
          params: { ImageBase64: 'page' },
          submit,
        }),
      ).resolves.toBe(`${mode}-job-id`);
      expect(submit).toHaveBeenCalledOnce();
    },
  );

  it('fails enforce closed on a history preflight outage before Submit', async () => {
    vi.stubEnv('AI_PROVIDER_ATTEMPT_ADMISSION_MODE', 'enforce');
    const submit = vi.fn(async () => 'must-not-submit');
    const bossJobId = 'enforce-closed-db';
    const pageOperationId = extractionPageOperationId({
      canonicalOperationId: bossJobId,
      bossJobId,
      pageIndex: 0,
    });
    const expectedAttemptId = providerOperationIdForInvocation(
      `ingestion-ocr:${pageOperationId}:tencent-submit:${bossJobId}:delivery:0`,
    );

    const rejection = executeTencentOcrSubmit({
      db: await closedDb(),
      pageOperationId,
      bossJobId,
      deliveryRetryCount: 0,
      deliveryStartedOn: new Date(),
      params: { ImageBase64: 'page' },
      submit,
    });

    await expect(rejection).rejects.toBeInstanceOf(ProviderAttemptLifecycleError);
    await expect(rejection).rejects.toMatchObject({
      reason: 'control_plane_unavailable',
      attemptId: expectedAttemptId,
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it('blocks a live saved JobId owner and resumes it only after atomic expiry', async () => {
    const pageOperationId = extractionPageOperationId({
      canonicalOperationId: `ingop_${randomUUID()}`,
      bossJobId: 'live-saved-owner',
      pageIndex: 0,
    });
    const ownerAttemptId = randomUUID();
    const owner = await createProviderAttemptLifecycle({
      mode: 'observe',
      identity: ProviderRequestIdentity.parse({
        attemptId: ownerAttemptId,
        operationId: pageOperationId,
        attemptKind: 'wire',
        provider: 'tencent',
        model: 'QuestionMarkAgent',
        lane: 'tencent.question-mark-agent',
        protocol: 'http',
        endpointClass: 'tencent.question-mark-agent.submit',
        caller: 'worker',
        operationKind: 'ocr_page_submit',
      }),
      deadlineAt: new Date(Date.now() + 60_000),
      providerStartFence: 'operation_kind',
      db,
    }).acquire();
    await owner.reserveProviderStart();
    await owner.recordExternalRequestId('live-saved-job');
    const submit = vi.fn(async () => 'must-not-submit');
    const retryInput = {
      db,
      pageOperationId,
      bossJobId: 'live-saved-owner',
      deliveryRetryCount: 1,
      deliveryStartedOn: new Date(),
      params: { ImageBase64: 'page' },
      submit,
    };

    await expect(executeTencentOcrSubmit(retryInput)).rejects.toMatchObject({
      reason: 'active_duplicate',
    });
    await db.execute(sql`UPDATE provider_attempt_admission
      SET lease_expires_at = clock_timestamp() - interval '1 second'
      WHERE attempt_id = ${ownerAttemptId}`);
    await expect(executeTencentOcrSubmit(retryInput)).resolves.toBe('live-saved-job');
    expect(submit).not.toHaveBeenCalled();
    expect(
      (
        await db
          .select()
          .from(provider_attempt_admission)
          .where(eq(provider_attempt_admission.attempt_id, ownerAttemptId))
      )[0],
    ).toMatchObject({ status: 'lease_expired', terminal_reason: 'lease_expired' });
  });

  it('fences a legacy generation attempt even when its terminal status is failed', async () => {
    const pageOperationId = extractionPageOperationId({
      canonicalOperationId: `ingop_${randomUUID()}`,
      bossJobId: 'unused-legacy-anchor',
      pageIndex: 0,
    });
    await db.insert(provider_attempt).values({
      ...legacySubmitAttempt(
        pageOperationId,
        'legacy-job-id-replaced-below',
        new Date('2026-08-09T00:00:00.000Z'),
      ),
      external_request_id: null,
      terminal_status: 'failed',
      terminal_reason: 'provider_attempt_failed',
    });
    const submit = vi.fn(async () => 'must-not-submit');

    await expect(
      executeTencentOcrSubmit({
        db,
        pageOperationId,
        bossJobId: 'legacy-fence',
        deliveryRetryCount: 1,
        deliveryStartedOn: new Date('2026-08-09T00:01:00.000Z'),
        params: { ImageBase64: 'page' },
        submit,
      }),
    ).rejects.toBeInstanceOf(TencentSubmitInProgressError);
    expect(submit).not.toHaveBeenCalled();
  });

  it('propagates conflicting saved JobIds and creates no recovery wire attempt', async () => {
    // Given: two crash-gap Submit attempts persisted different JobIds for one page operation.
    const pageOperationId = extractionPageOperationId({
      canonicalOperationId: `ingop_${randomUUID()}`,
      bossJobId: 'unused-canonical-anchor',
      pageIndex: 0,
    });
    await db
      .insert(provider_attempt)
      .values([
        legacySubmitAttempt(
          pageOperationId,
          'first-saved-job',
          new Date('2026-08-09T00:00:00.000Z'),
        ),
        legacySubmitAttempt(
          pageOperationId,
          'second-saved-job',
          new Date('2026-08-09T00:01:00.000Z'),
        ),
      ]);
    const before = await db
      .select()
      .from(provider_attempt)
      .where(eq(provider_attempt.operation_id, pageOperationId));

    const submit = vi.fn(async () => 'must-not-submit');

    // When: recovery tries to resolve the durable provider identity.
    await expect(
      executeTencentOcrSubmit({
        db,
        pageOperationId,
        bossJobId: 'conflicting-saved-jobs',
        deliveryRetryCount: 0,
        deliveryStartedOn: new Date(),
        params: { ImageBase64: 'page' },
        submit,
      }),
    ).rejects.toBeInstanceOf(ProviderAttemptResumeConflictError);

    // Then: the invariant error propagates before any recovery Submit or Describe can run.
    expect(submit).not.toHaveBeenCalled();
    const attempts = await db
      .select()
      .from(provider_attempt)
      .where(eq(provider_attempt.operation_id, pageOperationId));
    expect(attempts).toHaveLength(before.length);
  });
});
