// Worker regressions use the actual original, recorded executor and atomic settlement.
import { eq } from 'drizzle-orm';
import type { JobWithMetadata } from 'pg-boss';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  evaluation,
  event,
  job_events,
  knowledge,
  mastery_state,
  material_fsrs_state,
  question,
} from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { computeReplay } from '@/server/events/sse_replay';
import { nativeJudgeRunFixture } from '../../../../tests/fixtures/native-judge-run';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { executeNativeAttempt } from '../server/assessment/durable-attempt';
import { deriveJudgeRunStatus, terminalJudgeRunResult } from '../server/judge-run-status';
import { type JudgeRunJobData, buildJudgeRunHandler, runJudgeRun } from './judge_run';

const first = { retryCount: 0, retryLimit: 2 };
const final = { retryCount: 2, retryLimit: 2 };
const minute = 60_000;
async function replay(runId: string) {
  return computeReplay(testDb(), { businessTable: 'judge_run', businessId: runId, lastEventId: 0 });
}
function delivery(data: unknown): JobWithMetadata<JudgeRunJobData> {
  return { id: `delivery_${Math.random()}`, data, ...first } as JobWithMetadata<JudgeRunJobData>;
}
async function seedKc(id: string, domain = 'math') {
  const now = new Date();
  await testDb()
    .insert(knowledge)
    .values({ id, name: id, domain, created_at: now, updated_at: now });
}
beforeEach(resetDb);
afterEach(() => vi.restoreAllMocks());

describe('native judge worker', () => {
  it('persists original/candidate/completion with one learning effect and a complete DONE verdict', async () => {
    const db = testDb();
    await seedKc('k1');
    const f = await nativeJudgeRunFixture(db, { knowledgeIds: ['k1'] });
    expect(await runJudgeRun(db, f.job, first)).toMatchObject({
      status: 'done',
      coarse_outcome: 'correct',
      judge_event_id: null,
    });
    expect(await db.select().from(evaluation)).toHaveLength(1);
    expect(await db.select().from(event).where(eq(event.id, f.runId))).toHaveLength(1);
    expect(await db.select().from(material_fsrs_state)).toMatchObject([
      { subject_id: 'k1', state: { reps: 1 } },
    ]);
    expect(
      await db.select().from(mastery_state).where(eq(mastery_state.subject_id, 'k1')),
    ).toMatchObject([{ evidence_count: 1 }]);
    expect(terminalJudgeRunResult(await replay(f.runId))).toMatchObject({
      status: 'effective',
      coarse_outcome: 'correct',
      score: 1,
      score_meaning: 'correctness',
      feedback_md: expect.any(String),
      assessment: { original_evaluation_id: expect.any(String), candidate_id: expect.any(String) },
    });
  });

  it('uses the original KC-domain map after a reparent', async () => {
    const db = testDb();
    await seedKc('k1');
    const f = await nativeJudgeRunFixture(db, { knowledgeIds: ['k1'] });
    await db.update(knowledge).set({ domain: 'history' }).where(eq(knowledge.id, 'k1'));
    await runJudgeRun(db, f.job, first);
    expect(
      (
        await db
          .select()
          .from(mastery_state)
          .where(eq(mastery_state.subject_kind, 'ability_global'))
      ).map((row) => row.subject_id),
    ).toEqual(['math']);
  });

  it('idempotent redelivery never executes or schedules twice', async () => {
    const db = testDb();
    const f = await nativeJudgeRunFixture(db);
    await runJudgeRun(db, f.job, first);
    expect((await runJudgeRun(db, f.job, first)).status).toBe('skipped');
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(await db.select().from(evaluation)).toHaveLength(1);
    expect(await db.select().from(material_fsrs_state)).toMatchObject([{ state: { reps: 1 } }]);
  });

  it('retryable infrastructure failure leaves a nonterminal trace and rethrows', async () => {
    const db = testDb();
    const f = await nativeJudgeRunFixture(db);
    await expect(
      runJudgeRun(db, f.job, first, {
        executeNativeAttemptFn: async () => {
          throw new Error('database temporarily unavailable');
        },
      }),
    ).rejects.toThrow('temporarily');
    const events = await replay(f.runId);
    expect(deriveJudgeRunStatus(events)).toBe('started');
    expect(events.some((row) => row.event_type === 'judge_run.attempt_failed')).toBe(true);
    expect(events.some((row) => row.event_type === 'judge_run.failed')).toBe(false);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('releases a one-shot diagnostic claim when no independent model verdict is available', async () => {
    const db = testDb();
    const f = await nativeJudgeRunFixture(db, { requireUnassistedModelEvidence: true });
    await db
      .update(question)
      .set({
        source: 'intervention_diagnostic',
        draft_status: 'draft',
        updated_at: new Date(f.job.submit.submitted_at),
      })
      .where(eq(question.id, f.questionId));
    f.execute.mockRejectedValue(new Error('offline model unavailable'));
    expect((await runJudgeRun(db, f.job, first)).status).toBe('failed');
    const [q] = await db.select().from(question).where(eq(question.id, f.questionId));
    expect(q.draft_status).toBe('active');
    expect(await db.select().from(material_fsrs_state)).toHaveLength(0);
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('the final infrastructure failure persists FAILED and rethrows for DLQ', async () => {
    const db = testDb();
    const f = await nativeJudgeRunFixture(db);
    await expect(
      runJudgeRun(db, f.job, final, {
        executeNativeAttemptFn: async () => {
          throw new Error('database down');
        },
      }),
    ).rejects.toThrow('database down');
    expect(deriveJudgeRunStatus(await replay(f.runId))).toBe('failed');
  });

  it('unknown caller terminalizes without executing the model', async () => {
    const db = testDb();
    const f = await nativeJudgeRunFixture(db);
    expect(
      (await runJudgeRun(db, { ...f.job, caller: 'unknown' } as unknown as JudgeRunJobData, first))
        .status,
    ).toBe('failed');
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('a recorded model failure does not trigger provider fallback or another paid attempt on redelivery', async () => {
    const db = testDb();
    const f = await nativeJudgeRunFixture(db);
    f.execute.mockRejectedValue(new Error('offline model failed after dispatch'));
    await runJudgeRun(db, f.job, first);
    expect(terminalJudgeRunResult(await replay(f.runId))).toMatchObject({
      status: 'review_required',
      coarse_outcome: 'unsupported',
    });
    expect((await runJudgeRun(db, f.job, final)).status).toBe('skipped');
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(await db.select().from(material_fsrs_state)).toHaveLength(0);
  });

  it('reconstructs the full verdict after a committed run loses its DONE notification', async () => {
    const db = testDb();
    const f = await nativeJudgeRunFixture(db);
    await runJudgeRun(db, f.job, first);
    const original = terminalJudgeRunResult(await replay(f.runId));
    await db.delete(job_events).where(eq(job_events.business_id, f.runId));
    await runJudgeRun(db, f.job, first);
    expect(terminalJudgeRunResult(await replay(f.runId))).toEqual(original);
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('an invalid original timestamp is permanent and cannot reach the model', async () => {
    const db = testDb();
    const f = await nativeJudgeRunFixture(db);
    const bad = { ...f.job, submit: { ...f.job.submit, submitted_at: 'invalid-date' } };
    expect((await runJudgeRun(db, bad, first)).status).toBe('failed');
    expect((await replay(f.runId)).at(-1)?.payload).toMatchObject({
      error_code: 'invalid_payload',
    });
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('a payload that changes the accepted original is rejected before evaluation', async () => {
    const db = testDb();
    const f = await nativeJudgeRunFixture(db);
    expect(
      (
        await runJudgeRun(
          db,
          { ...f.job, submit: { ...f.job.submit, submission_id: 'another-original' } },
          first,
        )
      ).status,
    ).toBe('failed');
    expect(f.execute).not.toHaveBeenCalled();
    expect(await db.select().from(evaluation)).toHaveLength(0);
  });

  it.each([first, final])(
    'client traces classify errors without exposing internal text (retry=$retryCount)',
    async (meta) => {
      const db = testDb();
      const f = await nativeJudgeRunFixture(db);
      await expect(
        runJudgeRun(db, f.job, meta, {
          executeNativeAttemptFn: async () => {
            throw new Error('private-internal-path database error');
          },
        }),
      ).rejects.toThrow();
      const events = await replay(f.runId);
      expect(JSON.stringify(events)).not.toContain('private-internal-path');
      expect(events.at(-1)?.payload).toMatchObject({ error_code: 'judge_failed' });
    },
  );

  it('stored state corruption terminalizes immediately without retrying the execution', async () => {
    const db = testDb();
    const f = await nativeJudgeRunFixture(db);
    const execute = vi.fn(async () => {
      throw new ApiError('corrupt_state', 'internal invalid state', 422);
    });
    expect((await runJudgeRun(db, f.job, first, { executeNativeAttemptFn: execute })).status).toBe(
      'failed',
    );
    expect((await replay(f.runId)).at(-1)?.payload).toMatchObject({
      error_code: 'corrupt_state',
      reason: 'non_retryable',
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('grades the served question after current prompt, answer and labels change', async () => {
    const db = testDb();
    const f = await nativeJudgeRunFixture(db);
    await db
      .update(question)
      .set({ prompt_md: '后来替换题面', reference_md: '999', knowledge_ids: ['later'] })
      .where(eq(question.id, f.questionId));
    await runJudgeRun(db, f.job, first);
    expect(f.execute.mock.calls[0][0].question_parts[0].prompt_md).toContain('顺流18');
    expect(f.execute.mock.calls[0][0].slot_responses).toEqual(f.request.response_set.entries);
    expect((await db.select().from(material_fsrs_state)).map((row) => row.subject_id)).toEqual([
      f.questionId,
    ]);
  });

  it('does not rebuild missing legacy snapshots from a current row', async () => {
    const db = testDb();
    const f = await nativeJudgeRunFixture(db);
    const old = {
      run_id: 'legacy_without_binding',
      caller: 'submit' as const,
      submit: {
        question_id: f.questionId,
        body: { rating: 'good', auto_rate: true, response_md: '15' },
        subject_profile: {},
        submitted_at: new Date().toISOString(),
      },
    };
    expect((await runJudgeRun(db, old, first)).status).toBe('failed');
    expect((await replay(old.run_id)).at(-1)?.payload).toMatchObject({
      error_code: 'historical_unknown',
    });
    expect(f.execute).not.toHaveBeenCalled();
    expect(await db.select().from(material_fsrs_state)).toHaveLength(0);
  });

  it('late grading replays in original order without regressing the latest FSRS time', async () => {
    const db = testDb();
    const older = await nativeJudgeRunFixture(db, { now: new Date(Date.now() - 10 * minute) });
    const newer = await nativeJudgeRunFixture(db, {
      questionId: older.questionId,
      now: new Date(Date.now() - minute),
    });
    await runJudgeRun(db, newer.job, first);
    await runJudgeRun(db, older.job, first);
    const [card] = await db.select().from(material_fsrs_state);
    expect(card.state.reps).toBe(2);
    expect(new Date(card.state.last_review!).toISOString()).toBe(newer.job.submit.submitted_at);
  });

  it('late replay includes overlapping KC writes beyond one selected primary target', async () => {
    const db = testDb();
    await seedKc('k1');
    await seedKc('k2');
    const older = await nativeJudgeRunFixture(db, {
      knowledgeIds: ['k1', 'k2'],
      now: new Date(Date.now() - 10 * minute),
    });
    const newer = await nativeJudgeRunFixture(db, {
      knowledgeIds: ['k2'],
      now: new Date(Date.now() - minute),
    });
    await runJudgeRun(db, newer.job, first);
    await runJudgeRun(db, older.job, first);
    const cards = await db.select().from(material_fsrs_state);
    expect(cards.find((row) => row.subject_id === 'k1')?.state.reps).toBe(1);
    expect(cards.find((row) => row.subject_id === 'k2')?.state.reps).toBe(2);
    const [k2] = await db.select().from(mastery_state).where(eq(mastery_state.subject_id, 'k2'));
    expect(k2.evidence_count).toBe(2);
    expect(k2.last_outcome_at?.toISOString()).toBe(newer.job.submit.submitted_at);
  });

  it('in-order independent occurrences both advance scheduling', async () => {
    const db = testDb();
    const a = await nativeJudgeRunFixture(db);
    await runJudgeRun(db, a.job, first);
    const b = await nativeJudgeRunFixture(db, { questionId: a.questionId });
    await runJudgeRun(db, b.job, first);
    expect(await db.select().from(material_fsrs_state)).toMatchObject([{ state: { reps: 2 } }]);
  });

  it('a losing delivery recovers a committed winner instead of writing FAILED', async () => {
    const db = testDb();
    const f = await nativeJudgeRunFixture(db);
    const outcome = await runJudgeRun(db, f.job, first, {
      executeNativeAttemptFn: async (...args) => {
        await executeNativeAttempt(...args);
        throw new Error('duplicate delivery lost after winner committed');
      },
    });
    expect(outcome.status).toBe('skipped');
    expect(deriveJudgeRunStatus(await replay(f.runId))).toBe('done');
    expect((await replay(f.runId)).some((row) => row.event_type === 'judge_run.failed')).toBe(
      false,
    );
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('does not replace a winner’s complete DONE result on redelivery', async () => {
    const db = testDb();
    const f = await nativeJudgeRunFixture(db);
    await runJudgeRun(db, f.job, first);
    const before = await replay(f.runId);
    const execute = vi.fn(executeNativeAttempt);
    await runJudgeRun(db, f.job, first, { executeNativeAttemptFn: execute });
    expect(await replay(f.runId)).toEqual(before);
    expect(execute).not.toHaveBeenCalled();
  });

  it('one throwing job does not abandon its batch peers and the batch still fails', async () => {
    const db = testDb();
    const a = await nativeJudgeRunFixture(db);
    const b = await nativeJudgeRunFixture(db);
    const handler = buildJudgeRunHandler(db, {
      executeNativeAttemptFn: async (database, job) => {
        if (job.run_id === a.runId) throw new Error('first job unavailable');
        return executeNativeAttempt(database, job);
      },
    });
    await expect(handler([delivery(a.job), delivery(b.job)])).rejects.toThrow(
      'first job unavailable',
    );
    expect(deriveJudgeRunStatus(await replay(a.runId))).toBe('started');
    expect(deriveJudgeRunStatus(await replay(b.runId))).toBe('done');
  });

  it('a malformed job with a run ID terminalizes instead of disappearing', async () => {
    await buildJudgeRunHandler(testDb())([delivery({ run_id: 'malformed_with_id' })]);
    expect(deriveJudgeRunStatus(await replay('malformed_with_id'))).toBe('failed');
    expect((await replay('malformed_with_id')).at(-1)?.payload).toMatchObject({
      error_code: 'invalid_payload',
    });
  });

  it('a malformed job without a run ID fails the batch for DLQ visibility', async () => {
    await expect(
      buildJudgeRunHandler(testDb())([delivery({ caller: 'native_assessment', submit: {} })]),
    ).rejects.toThrow('missing run_id');
  });
});
