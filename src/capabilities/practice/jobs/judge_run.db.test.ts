// Worker regressions use the actual original, recorded executor and atomic settlement.
import { eq } from 'drizzle-orm';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { evaluation, knowledge, mastery_state, material_fsrs_state } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { computeReplay } from '@/server/events/sse_replay';
import { nativeJudgeRunFixture } from '../../../../tests/fixtures/native-judge-run';
import { resetDb, testDb } from '../../../../tests/helpers/db';

import { EvaluateSubmissionError } from '../server/judge/evaluate-submission';
import { deriveJudgeRunStatus } from '../server/judge-run-status';
import { runJudgeRun } from './judge_run';

const first = { retryCount: 0, retryLimit: 2 };
const final = { retryCount: 2, retryLimit: 2 };
const minute = 60_000;
async function replay(runId: string) {
  return computeReplay(testDb(), { businessTable: 'judge_run', businessId: runId, lastEventId: 0 });
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
  it('idempotent redelivery never executes or schedules twice', async () => {
    const db = testDb();
    const f = await nativeJudgeRunFixture(db);
    await runJudgeRun(db, f.job, first);
    expect((await runJudgeRun(db, f.job, first)).status).toBe('skipped');
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(await db.select().from(evaluation)).toHaveLength(1);
    expect(await db.select().from(material_fsrs_state)).toMatchObject([{ state: { reps: 1 } }]);
  });

  it.each([
    new Error('database temporarily unavailable'),
    new EvaluateSubmissionError('evaluation_busy', 'evaluation group is temporarily busy'),
  ])(
    'retryable infrastructure failure leaves a nonterminal trace and rethrows (%s)',
    async (error) => {
      const db = testDb();
      const f = await nativeJudgeRunFixture(db);
      await expect(
        runJudgeRun(db, f.job, first, {
          executeNativeAttemptFn: async () => {
            throw error;
          },
        }),
      ).rejects.toThrow(error);
      const events = await replay(f.runId);
      expect(deriveJudgeRunStatus(events)).toBe('started');
      expect(events.some((row) => row.event_type === 'judge_run.attempt_failed')).toBe(true);
      expect(events.some((row) => row.event_type === 'judge_run.failed')).toBe(false);
      expect(f.execute).not.toHaveBeenCalled();
    },
  );

  it('an invalid original timestamp is permanent and cannot reach the model', async () => {
    const db = testDb();
    const f = await nativeJudgeRunFixture(db);
    const bad = { ...f.job, submit: { ...f.job.submit, submitted_at: 'invalid-date' } };
    expect((await runJudgeRun(db, bad, first)).status).toBe('failed');
    expect((await replay(f.runId)).at(-1)?.payload).toMatchObject({
      error_code: 'terminal_delivery',
    });
    expect(f.execute).not.toHaveBeenCalled();
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
      expect(events.at(-1)?.payload).toMatchObject({
        error_code: meta.retryCount < meta.retryLimit ? 'judge_failed' : 'terminal_delivery',
      });
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
      error_code: 'terminal_delivery',
      reason: 'manual',
    });
    expect(execute).toHaveBeenCalledTimes(1);
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
    expect(card.state.last_review).toBeTruthy();
    if (!card.state.last_review) throw new Error('expected last review time');
    expect(new Date(card.state.last_review).toISOString()).toBe(newer.job.submit.submitted_at);
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
});
