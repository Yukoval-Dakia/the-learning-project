import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProviderRequestIdentity } from '@/core/schema/provider-attempt';
import { db } from '@/db/client';
import { provider_attempt_admission } from '@/db/schema';
import { createProviderAttemptLifecycle } from '@/server/ai/provider-attempt-lifecycle';
import { resetDb } from '../../../../tests/helpers/db';
import { executeTencentOcrSubmit, extractionPageOperationId } from './provider-attempts';

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
    const ownerLease = (
      await db
        .select()
        .from(provider_attempt_admission)
        .where(eq(provider_attempt_admission.attempt_id, ownerAttemptId))
    )[0]?.lease_owner;
    expect(ownerLease).toEqual(expect.any(String));
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
    const expiredOwner = (
      await db
        .select()
        .from(provider_attempt_admission)
        .where(eq(provider_attempt_admission.attempt_id, ownerAttemptId))
    )[0];
    expect(expiredOwner).toMatchObject({
      status: 'lease_expired',
      lease_owner: ownerLease,
      terminal_reason: 'lease_expired',
    });
    expect(expiredOwner?.terminal_at?.getTime()).toBeGreaterThanOrEqual(
      expiredOwner?.lease_expires_at?.getTime() ?? Number.POSITIVE_INFINITY,
    );
  });
});
