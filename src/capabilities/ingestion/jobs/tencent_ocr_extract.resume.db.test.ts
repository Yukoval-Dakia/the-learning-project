import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GlmLayoutResponse } from '@/capabilities/ingestion/server/glm_ocr';
import type { runStructureTask } from '@/capabilities/ingestion/server/structure';
import { db } from '@/db/client';
import { learning_session, provider_attempt, question_block } from '@/db/schema';
import { createImageR2, seedIngestionSession } from '@/server/session/ingestion-test-support';
import { resetDb } from '../../../../tests/helpers/db';
import { buildTencentOcrHandler } from './tencent_ocr_extract';

type RunStructureFn = typeof runStructureTask;

function glmResponse(requestId: string, text: string): GlmLayoutResponse {
  return {
    id: `id-${requestId}`,
    request_id: requestId,
    data_info: { num_pages: 1, pages: [{ width: 80, height: 120 }] },
    layout_details: [
      [
        {
          index: 0,
          label: 'text',
          native_label: 'paragraph',
          bbox_2d: [0, 0, 80, 120],
          content: text,
          width: 80,
          height: 120,
        },
      ],
    ],
    md_results: text,
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
  };
}

beforeEach(async () => {
  vi.stubEnv('AI_PROVIDER_ATTEMPT_ADMISSION_MODE', 'observe');
  vi.stubEnv(
    'AI_PROVIDER_ATTEMPT_ADMISSION_POLICIES_JSON',
    JSON.stringify({
      'glm.ocr-layout-parsing': {
        maxConcurrentAttempts: 100,
        maxAttemptStartsPerMinute: 1000,
      },
    }),
  );
  await resetDb();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('tencent_ocr_extract resumable provider attempts', () => {
  it('keeps GLM page operations stable while every real fetch gets a fresh attempt', async () => {
    // Given: page 1 succeeds, then page 2 has a retryable provider failure.
    const { sessionId, operationId } = await seedIngestionSession(2);
    vi.stubEnv('ZHIPU_API_KEY', 'test-zhipu-key');
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(glmResponse('delivery-1-page-0', 'page zero'))),
      )
      .mockRejectedValueOnce(new Error('page one transient'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(glmResponse('delivery-2-page-0', 'page zero'))),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(glmResponse('delivery-2-page-1', 'page one'))),
      );
    vi.stubGlobal('fetch', fetchFn);
    const runStructureFn = vi.fn(async () => ({
      questions: [
        {
          id: 'cross-page-question',
          role: 'standalone' as const,
          prompt_text: 'golden aggregate projection',
          source: 'vlm_structure' as const,
          page_index: 1,
        },
      ],
      layout_quality: 'structured' as const,
      extraction_confidence: 0.91,
      warnings: [],
    })) as RunStructureFn;
    const handler = buildTencentOcrHandler({
      db,
      r2: await createImageR2(),
      runStructureFn,
    });
    const firstDelivery = {
      id: 'stable-boss-job',
      data: { sessionId, operationId },
      retryCount: 0,
      retryLimit: 2,
    };

    // When: the first delivery fails and a new handler delivery resumes the extraction.
    await expect(handler([firstDelivery] as never)).rejects.toThrow('page one transient');
    const afterFirst = await db
      .select({ status: learning_session.status })
      .from(learning_session)
      .where(eq(learning_session.id, sessionId));
    const partialBlocks = await db
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, sessionId));
    expect(afterFirst[0]?.status).toBe('extracting');
    expect(partialBlocks).toHaveLength(0);
    await handler([{ ...firstDelivery, retryCount: 1 }] as never);

    // Then: both pages retain one operation identity across fresh wire attempts,
    // and only the final aggregate parser projection becomes product-visible.
    const attempts = await db
      .select()
      .from(provider_attempt)
      .where(eq(provider_attempt.lane_id, 'glm.ocr-layout-parsing'))
      .orderBy(asc(provider_attempt.started_at));
    const operationCounts = Map.groupBy(attempts, (attempt) => attempt.operation_id);
    expect(new Set(attempts.map((attempt) => attempt.protocol))).toEqual(new Set(['http']));
    expect(new Set(attempts.map((attempt) => attempt.endpoint_class))).toEqual(
      new Set(['glm.layout-parsing']),
    );
    expect([...operationCounts.values()].map((rows) => rows.length).sort()).toEqual([2, 2]);
    expect(new Set(attempts.map((attempt) => attempt.attempt_id)).size).toBe(4);
    expect(attempts.filter((attempt) => attempt.external_request_id !== null)).toHaveLength(3);
    expect(attempts.filter((attempt) => attempt.usage_json?.basis === 'reported')).toHaveLength(3);
    expect(attempts.filter((attempt) => attempt.cost_basis === 'estimated')).toHaveLength(3);
    expect(attempts.filter((attempt) => attempt.cost_basis === 'unknown')).toHaveLength(1);
    const finalBlocks = await db
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, sessionId));
    expect(finalBlocks).toHaveLength(1);
    expect(finalBlocks[0]?.structured?.prompt_text).toBe('golden aggregate projection');
    expect(finalBlocks[0]?.page_spans[0]?.page_index).toBe(1);
  });
});
