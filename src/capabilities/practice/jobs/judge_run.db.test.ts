// YUK-594 (durable judge main path, W1) — judge_run handler DB tests.
//
// Covers: enqueue→judge→single-tx backfill (attempt review event id=run_id + judge
// event + FSRS advance + terminal DONE); idempotent re-delivery does not double-write;
// judge failure writes a terminal FAILED trace AND rethrows for pg-boss re-delivery;
// a non-retryable caller writes FAILED without rethrowing. The judge itself is mocked
// at the judgeSubmit seam (no LLM call); the REAL persistSubmit runs the backfill tx.

import { newId } from '@/core/ids';
import { event, job_events, material_fsrs_state, question } from '@/db/schema';
import { computeReplay } from '@/server/events/sse_replay';
import { resolveSubjectProfile } from '@/subjects/profile';
import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { terminalJudgeRunResult } from '../server/judge-run-status';
import { deriveJudgeRunStatus } from '../server/judge-run-status';
import { type JudgeRunDeps, type JudgeRunJobData, runJudgeRun } from './judge_run';

const CORRECT_VERDICT = {
  coarse_outcome: 'correct' as const,
  score: 1,
  score_meaning: 'correctness' as const,
  confidence: 0.9,
  capability_ref: { id: 'semantic', version: '1.0.0' },
  feedback_md: 'looks right',
  evidence_json: {},
};

// A JudgedSubmit-shaped fixture the mock judgeSubmit returns (auto_rate → 'good').
const JUDGED_GOOD = {
  judgeResult: CORRECT_VERDICT,
  judgeRoute: 'semantic',
  judgeTelemetry: null,
  executionProvenance: null,
  suggestedRating: 'good' as const,
  finalRating: 'good' as const,
  adviceCauseCategory: null,
};

function mockJudgeSubmit(
  overrides: Partial<typeof JUDGED_GOOD> = {},
): JudgeRunDeps['judgeSubmitFn'] {
  return (async () => ({ ...JUDGED_GOOD, ...overrides })) as JudgeRunDeps['judgeSubmitFn'];
}

async function seedQuestion(id: string) {
  const now = new Date();
  await testDb()
    .insert(question)
    .values({
      id,
      prompt_md: `Prompt for ${id}`,
      kind: 'short_answer',
      reference_md: null,
      knowledge_ids: ['k1'],
      difficulty: 3,
      source: 'manual',
      variant_depth: 0,
      version: 0,
      created_at: now,
      updated_at: now,
    });
}

function jobData(
  runId: string,
  questionId: string,
  over: Partial<JudgeRunJobData> = {},
): JudgeRunJobData {
  return {
    run_id: runId,
    caller: 'submit',
    submit: {
      body: { question_id: questionId, response_md: 'my answer', rating: 'good', auto_rate: true },
      question_id: questionId,
      subject_profile: resolveSubjectProfile(),
      submitted_at: new Date().toISOString(),
    },
    ...over,
  };
}

const META0 = { retryCount: 0, retryLimit: 2 };

describe('runJudgeRun — backfill', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('judges then backfills the attempt (review event id=run_id) + judge event + FSRS + terminal DONE', async () => {
    const db = testDb();
    const questionId = `q_${newId()}`;
    await seedQuestion(questionId);
    const runId = newId();

    const result = await runJudgeRun(db, jobData(runId, questionId), META0, {
      judgeSubmitFn: mockJudgeSubmit(),
    });
    expect(result.status).toBe('done');

    // attempt review event was written with id = run_id (the run handle ≡ attempt id).
    const attempt = await db.select().from(event).where(eq(event.id, runId));
    expect(attempt).toHaveLength(1);
    expect(attempt[0].action).toBe('review');
    expect(attempt[0].subject_id).toBe(questionId);

    // an independent judge event chained to the attempt was written.
    const judgeEvents = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'judge'), eq(event.subject_id, runId)));
    expect(judgeEvents).toHaveLength(1);

    // FSRS advanced for the knowledge subject.
    const fsrs = await db
      .select()
      .from(material_fsrs_state)
      .where(eq(material_fsrs_state.subject_id, 'k1'));
    expect(fsrs.length).toBeGreaterThan(0);

    // terminal DONE carries the verdict; status derives to done.
    const events = await computeReplay(db, {
      businessTable: 'judge_run',
      businessId: runId,
      lastEventId: 0,
    });
    expect(deriveJudgeRunStatus(events)).toBe('done');
    const done = events.find((e) => e.event_type === 'judge_run.done');
    expect((done?.payload as { coarse_outcome?: string } | undefined)?.coarse_outcome).toBe(
      'correct',
    );
  });

  it('idempotent re-delivery after commit does not double-write (skips, keeps one attempt + one judge)', async () => {
    const db = testDb();
    const questionId = `q_${newId()}`;
    await seedQuestion(questionId);
    const runId = newId();

    await runJudgeRun(db, jobData(runId, questionId), META0, { judgeSubmitFn: mockJudgeSubmit() });
    // Re-deliver the same run_id (worker crashed after commit, before pg-boss marked done).
    const second = await runJudgeRun(
      db,
      jobData(runId, questionId),
      { retryCount: 1, retryLimit: 2 },
      {
        judgeSubmitFn: mockJudgeSubmit(),
      },
    );
    expect(second.status).toBe('skipped');

    const attempts = await db.select().from(event).where(eq(event.id, runId));
    expect(attempts).toHaveLength(1);
    const judgeEvents = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'judge'), eq(event.subject_id, runId)));
    expect(judgeEvents).toHaveLength(1);
  });

  it('judge failure writes a terminal FAILED trace AND rethrows for re-delivery (no attempt written)', async () => {
    const db = testDb();
    const questionId = `q_${newId()}`;
    await seedQuestion(questionId);
    const runId = newId();

    const boom = (async () => {
      throw new Error('endpoint down');
    }) as JudgeRunDeps['judgeSubmitFn'];

    await expect(
      runJudgeRun(db, jobData(runId, questionId), META0, { judgeSubmitFn: boom }),
    ).rejects.toThrow('endpoint down');

    // no attempt persisted (backfill never reached).
    const attempts = await db.select().from(event).where(eq(event.id, runId));
    expect(attempts).toHaveLength(0);
    // terminal FAILED trace so replay/UI is not stuck queued.
    const events = await computeReplay(db, {
      businessTable: 'judge_run',
      businessId: runId,
      lastEventId: 0,
    });
    expect(deriveJudgeRunStatus(events)).toBe('failed');
  });

  it('non-retryable caller (unknown face) writes FAILED without rethrowing', async () => {
    const db = testDb();
    const runId = newId();
    const data = { ...jobData(runId, 'q_unused'), caller: 'probe' } as unknown as JudgeRunJobData;

    const result = await runJudgeRun(db, data, META0, { judgeSubmitFn: mockJudgeSubmit() });
    expect(result.status).toBe('failed');
    const events = await computeReplay(db, {
      businessTable: 'judge_run',
      businessId: runId,
      lastEventId: 0,
    });
    expect(deriveJudgeRunStatus(events)).toBe('failed');
    // no attempt event.
    expect(await testDb().select().from(event).where(eq(event.id, runId))).toHaveLength(0);
  });

  it('crosses to the fallback provider lane on the final delivery (D9)', async () => {
    const db = testDb();
    const questionId = `q_${newId()}`;
    await seedQuestion(questionId);
    const runId = newId();
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'tok');

    let seenDurable: unknown;
    const capturingJudge = (async (_validated: unknown, opts: { durable?: unknown }) => {
      seenDurable = opts?.durable;
      return { ...JUDGED_GOOD };
    }) as JudgeRunDeps['judgeSubmitFn'];

    // retryCount == retryLimit → final delivery → provider override applied.
    await runJudgeRun(
      db,
      jobData(runId, questionId),
      { retryCount: 2, retryLimit: 2 },
      {
        judgeSubmitFn: capturingJudge,
      },
    );
    expect(seenDurable).toEqual({ providerOverride: 'anthropic-sub' });
    vi.unstubAllEnvs();
  });

  it('recovery: backfill committed but DONE lost → reconstructs the FULL verdict (not a slim DONE) on re-delivery', async () => {
    const db = testDb();
    const questionId = `q_${newId()}`;
    await seedQuestion(questionId);
    const runId = newId();

    await runJudgeRun(db, jobData(runId, questionId), META0, { judgeSubmitFn: mockJudgeSubmit() });
    // Simulate a crash between the persist commit and the terminal DONE write: the
    // attempt event exists but the DONE job_event is gone.
    await db
      .delete(job_events)
      .where(and(eq(job_events.business_id, runId), eq(job_events.event_type, 'judge_run.done')));

    const second = await runJudgeRun(
      db,
      jobData(runId, questionId),
      { retryCount: 1, retryLimit: 2 },
      {
        judgeSubmitFn: mockJudgeSubmit(),
      },
    );
    expect(second.status).toBe('skipped');

    // The reconstructed terminal DONE carries the REAL verdict from the judge event,
    // not a slim placeholder — poll/SSE recovery gets coarse_outcome back.
    const events = await computeReplay(db, {
      businessTable: 'judge_run',
      businessId: runId,
      lastEventId: 0,
    });
    const result = terminalJudgeRunResult(events) as { coarse_outcome?: string } | null;
    expect(result?.coarse_outcome).toBe('correct');
  });

  it('malformed payload (invalid submitted_at) is non-retryable — FAILED, no rethrow, no attempt', async () => {
    const db = testDb();
    const questionId = `q_${newId()}`;
    await seedQuestion(questionId);
    const runId = newId();
    const bad = jobData(runId, questionId);
    bad.submit.submitted_at = 'not-a-date';

    const result = await runJudgeRun(db, bad, META0, { judgeSubmitFn: mockJudgeSubmit() });
    expect(result.status).toBe('failed');
    const events = await computeReplay(db, {
      businessTable: 'judge_run',
      businessId: runId,
      lastEventId: 0,
    });
    expect(deriveJudgeRunStatus(events)).toBe('failed');
    expect(
      (events.find((e) => e.event_type === 'judge_run.failed')?.payload as { reason?: string })
        ?.reason,
    ).toBe('non_retryable');
    expect(await db.select().from(event).where(eq(event.id, runId))).toHaveLength(0);
  });

  it('malformed payload (bad body → ZodError) is non-retryable — FAILED, no rethrow', async () => {
    const db = testDb();
    const runId = newId();
    const bad = {
      ...jobData(runId, 'q_unused'),
      submit: {
        body: { not: 'valid' },
        question_id: 'q_unused',
        subject_profile: resolveSubjectProfile(),
        submitted_at: new Date().toISOString(),
      },
    } as JudgeRunJobData;

    const result = await runJudgeRun(db, bad, META0, { judgeSubmitFn: mockJudgeSubmit() });
    expect(result.status).toBe('failed');
    const events = await computeReplay(db, {
      businessTable: 'judge_run',
      businessId: runId,
      lastEventId: 0,
    });
    expect(deriveJudgeRunStatus(events)).toBe('failed');
  });
});
