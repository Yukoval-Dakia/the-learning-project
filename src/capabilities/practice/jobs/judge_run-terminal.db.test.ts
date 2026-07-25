// YUK-594 — terminal job_event write failures must NOT be swallowed.
//
// #2 regression: the backfill committed but the DONE job_event write throws → the handler
// must rethrow (→ pg-boss redelivery → idempotency guard reconstructs DONE), and must NOT
// write a misleading FAILED.
//
// #3 regression (codex, round 3): the SAME rule on the FAILED side. A non-retryable run
// whose terminal `judge_run.failed` insert itself fails used to go through
// `bestEffortWriteJobEvent`, which swallowed the write error while the branch returned
// SUCCESS — pg-boss dropped the job and poll/SSE sat queued forever with no terminal event.
//
// The writer is mocked to throw only on the event_type under test.

import { newId } from '@/core/ids';
import { event, question } from '@/db/schema';
import { resolveSubjectProfile } from '@/subjects/profile';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';

const { writeJobEventSpy, failOn } = vi.hoisted(() => ({
  writeJobEventSpy: vi.fn(),
  failOn: { eventType: 'judge_run.done' },
}));

vi.mock('@/server/events/writer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/events/writer')>();
  writeJobEventSpy.mockImplementation(async (db: unknown, args: { event_type: string }) => {
    if (args.event_type === failOn.eventType) throw new Error(`${failOn.eventType} write boom`);
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

async function seedQuestion(db: ReturnType<typeof testDb>, questionId: string) {
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
}

describe('runJudgeRun — terminal DONE write failure (#2)', () => {
  beforeEach(async () => {
    await resetDb();
    writeJobEventSpy.mockClear();
    failOn.eventType = 'judge_run.done';
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
    ).rejects.toThrow('judge_run.done write boom');

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

describe('runJudgeRun — terminal FAILED write failure (#3)', () => {
  beforeEach(async () => {
    await resetDb();
    writeJobEventSpy.mockClear();
    failOn.eventType = 'judge_run.failed';
  });

  it('a NON-RETRYABLE run whose terminal FAILED write throws rethrows instead of returning success', async () => {
    const db = testDb();
    const runId = newId();
    // An unknown caller is the non-retryable branch: pre-fix it wrote FAILED best-effort
    // (swallowing this write error) and then RETURNED SUCCESS — pg-boss dropped the job and
    // the run had no terminal event at all, so poll/SSE hung pending forever.
    const data = {
      run_id: runId,
      caller: 'probe',
      submit: {
        body: { question_id: 'q_unused', response_md: 'a', rating: 'good', auto_rate: true },
        question_id: 'q_unused',
        subject_profile: resolveSubjectProfile(),
        submitted_at: new Date().toISOString(),
      },
    } as unknown as JudgeRunJobData;

    await expect(
      runJudgeRun(db, data, { retryCount: 0, retryLimit: 2 }, { judgeSubmitFn: mockJudge }),
    ).rejects.toThrow('judge_run.failed write boom');

    const types = writeJobEventSpy.mock.calls.map(
      (c) => (c[1] as { event_type: string }).event_type,
    );
    expect(types).toContain('judge_run.failed');
  });

  it('a RETRYABLE judge failure whose terminal FAILED write throws still rethrows for redelivery', async () => {
    const db = testDb();
    const questionId = `q_${newId()}`;
    await seedQuestion(db, questionId);
    const runId = newId();

    const boom = (async () => {
      throw new Error('endpoint down');
    }) as JudgeRunDeps['judgeSubmitFn'];

    // Either error reaching pg-boss redelivers the run; what matters is that the handler
    // does NOT resolve successfully with no terminal event on record.
    await expect(
      runJudgeRun(
        db,
        jobData(runId, questionId),
        { retryCount: 0, retryLimit: 2 },
        { judgeSubmitFn: boom },
      ),
    ).rejects.toThrow();

    expect(await db.select().from(event).where(eq(event.id, runId))).toHaveLength(0);
  });
});
