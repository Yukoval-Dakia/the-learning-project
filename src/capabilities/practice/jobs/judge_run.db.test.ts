// Worker regressions use the actual original, recorded executor and atomic settlement.

import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluation, knowledge, mastery_state, material_fsrs_state } from '@/db/schema';
import { nativeJudgeRunFixture } from '../../../../tests/fixtures/native-judge-run';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { runJudgeRun } from './judge_run';

const first = { retryCount: 0, retryLimit: 2 };
const minute = 60_000;
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
