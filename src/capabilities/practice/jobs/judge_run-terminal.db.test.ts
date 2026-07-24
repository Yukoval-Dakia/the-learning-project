// YUK-594 — #2 regression: a failed TERMINAL DONE write must NOT be swallowed.
// If the backfill committed but the DONE job_event write throws, the handler must
// rethrow (→ pg-boss redelivery → idempotency guard reconstructs DONE), and must NOT
// write a misleading FAILED. The writer is mocked to throw only on 'judge_run.done'.

import { newId } from '@/core/ids';
import { event, question } from '@/db/schema';
import { resolveSubjectProfile } from '@/subjects/profile';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';

const { writeJobEventSpy } = vi.hoisted(() => ({ writeJobEventSpy: vi.fn() }));

vi.mock('@/server/events/writer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/events/writer')>();
  writeJobEventSpy.mockImplementation(async (db: unknown, args: { event_type: string }) => {
    if (args.event_type === 'judge_run.done') throw new Error('DONE write boom');
    return actual.writeJobEvent(
      db as Parameters<typeof actual.writeJobEvent>[0],
      args as Parameters<typeof actual.writeJobEvent>[1],
    );
  });
  return { ...actual, writeJobEvent: writeJobEventSpy };
});

import { type JudgeRunDeps, type JudgeRunJobData, runJudgeRun } from './judge_run';

const JUDGED_GOOD = {
  judgeResult: {
    coarse_outcome: 'correct' as const,
    score: 1,
    score_meaning: 'correctness' as const,
    confidence: 0.9,
    capability_ref: { id: 'semantic', version: '1.0.0' },
    feedback_md: 'ok',
    evidence_json: {},
  },
  judgeRoute: 'semantic',
  judgeTelemetry: null,
  executionProvenance: null,
  suggestedRating: 'good' as const,
  finalRating: 'good' as const,
  adviceCauseCategory: null,
};

const mockJudge = (async () => ({ ...JUDGED_GOOD })) as JudgeRunDeps['judgeSubmitFn'];

function jobData(runId: string, questionId: string): JudgeRunJobData {
  return {
    run_id: runId,
    caller: 'submit',
    submit: {
      body: { question_id: questionId, response_md: 'a', rating: 'good', auto_rate: true },
      question_id: questionId,
      subject_profile: resolveSubjectProfile(),
      submitted_at: new Date().toISOString(),
    },
  };
}

describe('runJudgeRun — terminal DONE write failure (#2)', () => {
  beforeEach(async () => {
    await resetDb();
    writeJobEventSpy.mockClear();
  });

  it('rethrows for redelivery + writes NO FAILED when the DONE write fails after commit', async () => {
    const db = testDb();
    const questionId = `q_${newId()}`;
    await db.insert(question).values({
      id: questionId,
      prompt_md: 'p',
      kind: 'short_answer',
      reference_md: null,
      knowledge_ids: ['k1'],
      difficulty: 3,
      source: 'manual',
      variant_depth: 0,
      version: 0,
      created_at: new Date(),
      updated_at: new Date(),
    });
    const runId = newId();

    // The DONE write throws → handler must rethrow (NOT swallow, NOT return done).
    await expect(
      runJudgeRun(
        db,
        jobData(runId, questionId),
        { retryCount: 0, retryLimit: 2 },
        {
          judgeSubmitFn: mockJudge,
        },
      ),
    ).rejects.toThrow('DONE write boom');

    // The backfill COMMITTED — the attempt review event was persisted (real writeEvent).
    expect(await db.select().from(event).where(eq(event.id, runId))).toHaveLength(1);

    // A DONE write was ATTEMPTED, and NO misleading FAILED was written (the run succeeded).
    const types = writeJobEventSpy.mock.calls.map(
      (c) => (c[1] as { event_type: string }).event_type,
    );
    expect(types).toContain('judge_run.done');
    expect(types).not.toContain('judge_run.failed');
  });
});
