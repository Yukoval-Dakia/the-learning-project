import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/db/client';
import { provider_attempt } from '@/db/schema';
import { resetDb } from '../../../../tests/helpers/db';
import {
  ProviderAttemptResumeConflictError,
  TencentSubmitInProgressError,
  executeTencentOcrSubmit,
  extractionPageOperationId,
  findSavedTencentJobId,
} from './provider-attempts';

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

    // When: recovery tries to resolve the durable provider identity.
    await expect(findSavedTencentJobId(db, pageOperationId)).rejects.toBeInstanceOf(
      ProviderAttemptResumeConflictError,
    );

    // Then: the invariant error propagates before any recovery Submit or Describe can run.
    const attempts = await db
      .select()
      .from(provider_attempt)
      .where(eq(provider_attempt.operation_id, pageOperationId));
    expect(attempts).toHaveLength(before.length);
  });
});
