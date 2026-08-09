import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  readIngestionOperation,
  reserveIngestionOperation,
} from '@/capabilities/ingestion/server/operation-store';
import { TencentSubmitInProgressError } from '@/capabilities/ingestion/server/provider-attempts';
import type { DescribeResponse } from '@/capabilities/ingestion/server/tencent_mark';
import { db } from '@/db/client';
import { job_events, learning_session, provider_attempt } from '@/db/schema';
import { createImageR2, seedIngestionSession } from '@/server/session/ingestion-test-support';
import tencentDone from '../../../../tests/fixtures/tencent_mark_agent_cloze_sample.json';
import { resetDb } from '../../../../tests/helpers/db';
import { buildTencentOcrHandler } from './tencent_ocr_extract';

function structureResult() {
  return {
    questions: [
      {
        id: 'concurrency-question',
        role: 'standalone' as const,
        prompt_text: 'single aggregate result',
        source: 'vlm_structure' as const,
      },
    ],
    layout_quality: 'structured' as const,
    extraction_confidence: 0.9,
    warnings: [],
  };
}

async function reserveOperation(sessionId: string, operationId: string): Promise<void> {
  await reserveIngestionOperation(db, {
    sessionId,
    operationId,
    operationKind: 'extract',
    inputHash: `hash-${operationId}`,
  });
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

describe('Tencent OCR concurrent delivery fencing', () => {
  it('sends one Submit when retry generations overlap at the provider wire', async () => {
    // Given: generation 0 is paused inside the provider Submit wire.
    const { sessionId, operationId } = await seedIngestionSession(1);
    await reserveOperation(sessionId, operationId);
    let releaseWinner: () => void = () => undefined;
    const winnerRelease = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });
    let winnerEntered: () => void = () => undefined;
    const winnerWireEntered = new Promise<void>((resolve) => {
      winnerEntered = resolve;
    });
    let competitionObserved: () => void = () => undefined;
    const competitionReachedFenceOrWire = new Promise<void>((resolve) => {
      competitionObserved = resolve;
    });
    let submitCount = 0;
    const submitFn = vi.fn(async () => {
      submitCount += 1;
      if (submitCount === 1) {
        winnerEntered();
        await winnerRelease;
        return 'winner-job-id';
      }
      competitionObserved();
      return 'duplicate-job-id';
    });
    const handler = buildTencentOcrHandler({
      db,
      r2: await createImageR2(),
      engine: 'tencent',
      submitFn,
      describeFn: vi.fn(
        async (_jobId: string): Promise<DescribeResponse> => ({
          ...tencentDone,
          JobStatus: 'DONE',
        }),
      ),
      runStructureFn: vi.fn(async () => structureResult()),
    });
    const delivery = {
      id: 'overlapping-generation-job',
      data: { sessionId, operationId },
      retryCount: 0,
      retryLimit: 2,
      startedOn: new Date(),
    };

    // When: the final retry crosses findSaved before generation 0 persists its JobId.
    const winner = handler([delivery] as never);
    await winnerWireEntered;
    const competitor = handler([{ ...delivery, retryCount: 2 }] as never);
    competitor.finally(competitionObserved).catch(() => undefined);
    await competitionReachedFenceOrWire;
    releaseWinner();
    const outcomes = await Promise.allSettled([winner, competitor]);

    // Then: the attempt fence permits one wire and the competition never terminalizes extraction.
    expect(submitFn).toHaveBeenCalledOnce();
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejected?.reason).toBeInstanceOf(TencentSubmitInProgressError);
    expect(rejected?.reason.reason).toBe('active_duplicate');
    const session = await db
      .select({ status: learning_session.status })
      .from(learning_session)
      .where(eq(learning_session.id, sessionId));
    expect(session[0]?.status).toBe('extracted');
    const submitAttempts = await db
      .select()
      .from(provider_attempt)
      .where(eq(provider_attempt.operation_kind, 'ocr_page_submit'));
    expect(submitAttempts).toHaveLength(1);
  });

  it('preserves a completed operation when a late delivery fails locally', async () => {
    // Given: one canonical delivery has completed the extraction and operation projection.
    const { sessionId, operationId } = await seedIngestionSession(1);
    await reserveOperation(sessionId, operationId);
    const handler = buildTencentOcrHandler({
      db,
      r2: await createImageR2(),
      engine: 'tencent',
      submitFn: vi.fn(async () => 'completed-job-id'),
      describeFn: vi.fn(
        async (_jobId: string): Promise<DescribeResponse> => ({
          ...tencentDone,
          JobStatus: 'DONE',
        }),
      ),
      runStructureFn: vi.fn(async () => structureResult()),
    });
    const delivery = {
      id: 'late-delivery-job',
      data: { sessionId, operationId },
      retryCount: 0,
      retryLimit: 2,
      startedOn: new Date('2026-08-09T00:00:00.000Z'),
    };
    await handler([delivery] as never);

    // When: a late retry reaches the already-completed session and rejects locally.
    await expect(
      handler([
        { ...delivery, retryCount: 1, startedOn: new Date('2026-08-09T00:01:00.000Z') },
      ] as never),
    ).rejects.toThrow();

    // Then: completed remains the first terminal truth and no reverse terminal event is appended.
    const operation = await readIngestionOperation(db, operationId);
    expect(operation?.status).toBe('succeeded');
    const events = await db
      .select({ eventType: job_events.event_type })
      .from(job_events)
      .where(
        and(
          eq(job_events.business_table, 'ingestion_operation'),
          eq(job_events.business_id, operationId),
        ),
      );
    expect(events.some((event) => event.eventType === 'operation.completed')).toBe(true);
    expect(events.some((event) => event.eventType === 'operation.failed')).toBe(false);
  });
});
