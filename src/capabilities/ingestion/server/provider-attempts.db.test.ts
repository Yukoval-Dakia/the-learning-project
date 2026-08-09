import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { db } from '@/db/client';
import { provider_attempt } from '@/db/schema';
import { resetDb } from '../../../../tests/helpers/db';
import {
  ProviderAttemptResumeConflictError,
  executeTencentOcrSubmit,
  extractionPageOperationId,
  findSavedTencentJobId,
} from './provider-attempts';

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
  it('propagates conflicting saved JobIds and creates no recovery wire attempt', async () => {
    // Given: two crash-gap Submit attempts persisted different JobIds for one page operation.
    const pageOperationId = extractionPageOperationId({
      canonicalOperationId: `ingop_${randomUUID()}`,
      bossJobId: 'unused-canonical-anchor',
      pageIndex: 0,
    });
    await executeTencentOcrSubmit({
      db,
      pageOperationId,
      deliveryRetryCount: 0,
      deliveryStartedOn: new Date('2026-08-09T00:00:00.000Z'),
      params: { ImageBase64: 'page' },
      submit: async () => 'first-saved-job',
    });
    await executeTencentOcrSubmit({
      db,
      pageOperationId,
      deliveryRetryCount: 1,
      deliveryStartedOn: new Date('2026-08-09T00:01:00.000Z'),
      params: { ImageBase64: 'page' },
      submit: async () => 'second-saved-job',
    });
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
