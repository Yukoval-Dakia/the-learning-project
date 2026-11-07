import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { reserveIngestionOperation } from '@/capabilities/ingestion/server/operation-store';
import { TencentSubmitInProgressError } from '@/capabilities/ingestion/server/provider-attempts';
import type { DescribeResponse } from '@/capabilities/ingestion/server/tencent_mark';
import { db } from '@/db/client';
import { learning_session, provider_attempt, question_block } from '@/db/schema';
import tencentDone from '../../../../tests/fixtures/tencent_mark_agent_cloze_sample.json';
import { resetDb } from '../../../../tests/helpers/db';
import { readIngestionSessionDetail } from '../server/session-detail';
import { runStructureTask } from '../server/structure';
import { createImageR2, seedIngestionSession } from './ingestion-test-support';
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
  it('sends one Submit when different final retry generations overlap', async () => {
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

    // When: a competing delivery reaches history resolution before generation 0 persists its JobId.
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
});

// @invariant security: crop handwriting evidence controls publication without exposing known student work
// @fails-if known handwriting is attached or unknown handwriting is hidden or loses its durable warning
it('retains clean and unverified option crops but withholds known handwriting', async () => {
  for (const handwriting of [false, null, true]) {
    const { sessionId } = await seedIngestionSession(1);
    const handler = buildTencentOcrHandler({
      db,
      r2: await createImageR2(),
      engine: 'glm',
      glmOcrFn: async () => ({
        id: 'crop-layout',
        request_id: 'crop-layout',
        md_results: '1. Choose A.',
        data_info: { num_pages: 1, pages: [{ width: 80, height: 120 }] },
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        layout_details: [
          [
            {
              index: 0,
              label: 'text',
              native_label: 'paragraph',
              bbox_2d: [0, 0, 80, 30],
              width: 80,
              height: 120,
              content: '1. Choose A.',
            },
            {
              index: 1,
              label: 'image',
              native_label: 'image',
              bbox_2d: [10, 40, 50, 80],
              width: 80,
              height: 120,
            },
          ],
        ],
      }),
      runStructureFn: (params) =>
        runStructureTask({
          ...params,
          runTaskFn: async () => ({
            text: JSON.stringify({
              layout_quality: 'structured',
              extraction_confidence: 0.9,
              content_lost: false,
              figure_handwriting: [{ figure_index: 0, student_answer_present: handwriting }],
              questions: [
                {
                  role: 'standalone',
                  prompt_text: 'Choose A.',
                  student_answer_present: false,
                  options: [{ label: 'A', text: '', figure_ids: [0] }],
                },
              ],
            }),
          }),
        }),
    });
    await handler([
      {
        id: `crop-${sessionId}`,
        data: { sessionId },
        retryCount: 0,
        retryLimit: 0,
        startedOn: new Date(),
      },
    ] as never);
    const [block] = await db
      .select()
      .from(question_block)
      .where(eq(question_block.ingestion_session_id, sessionId));
    expect(
      block.figures?.map((figure) => [figure.option_label, figure.handwriting_unverified]),
    ).toEqual(handwriting === true ? [] : [['A', handwriting === null]]);
    const { session } = await readIngestionSessionDetail(sessionId);
    expect([
      session.figures_withheld,
      session.figure_handwriting_unverified,
      session.content_lost,
    ]).toEqual([handwriting === true, handwriting === null, false]);
  }
});
