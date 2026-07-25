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
import { freezeQuestionForJudge } from '../server/judge-run-payload';
import { terminalJudgeRunResult } from '../server/judge-run-status';
import { deriveJudgeRunStatus } from '../server/judge-run-status';
import {
  type JudgeRunDeps,
  type JudgeRunJobData,
  buildJudgeRunHandler,
  runJudgeRun,
} from './judge_run';

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

  // #6 — the FAILED payload rides the generic SSE face verbatim, so it must carry a
  // classified code, never the raw error text (DB strings / internal paths / provider
  // response fragments). The raw message stays in the server log.
  it('FAILED payload carries a classified code, NOT the raw error message', async () => {
    const db = testDb();
    const questionId = `q_${newId()}`;
    await seedQuestion(questionId);
    const runId = newId();
    const secret = 'connection to 10.0.0.7:5432 refused (/srv/app/internal/path.ts)';
    const boom = (async () => {
      throw new Error(secret);
    }) as JudgeRunDeps['judgeSubmitFn'];

    await expect(
      runJudgeRun(db, jobData(runId, questionId), META0, { judgeSubmitFn: boom }),
    ).rejects.toThrow(secret);

    const events = await computeReplay(db, {
      businessTable: 'judge_run',
      businessId: runId,
      lastEventId: 0,
    });
    const failed = events.find((e) => e.event_type === 'judge_run.failed');
    const payload = failed?.payload as Record<string, unknown>;
    expect(payload.reason).toBe('error');
    expect(payload.error_code).toBe('judge_failed');
    // The client-facing payload must not contain the raw message under ANY key.
    expect(JSON.stringify(payload)).not.toContain('10.0.0.7');
    expect(JSON.stringify(payload)).not.toContain('/srv/app/internal');
  });
});

// ── #2 (codex) — 题目数据冻结 ────────────────────────────────────────────────
describe('runJudgeRun — frozen question snapshot (#2)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('judges against the question the LEARNER ANSWERED, not the row edited after the 202', async () => {
    const db = testDb();
    const questionId = `q_${newId()}`;
    await seedQuestion(questionId);
    const runId = newId();

    // Freeze the row the learner saw, exactly as enqueueDurableJudge does.
    const [answered] = await db.select().from(question).where(eq(question.id, questionId));
    const data = jobData(runId, questionId);
    data.submit.question_snapshot = freezeQuestionForJudge(answered);

    // Between the 202 and the worker pickup, someone edits the question.
    await db
      .update(question)
      .set({
        prompt_md: 'EDITED AFTER SUBMIT',
        reference_md: 'EDITED REFERENCE',
        difficulty: 5,
        knowledge_ids: ['k_edited'],
      })
      .where(eq(question.id, questionId));

    const captured: {
      q?: {
        prompt_md: string;
        reference_md: string | null;
        difficulty: number;
        knowledge_ids: string[];
      };
    } = {};
    const capturing = (async (validated: { q: NonNullable<typeof captured.q> }) => {
      captured.q = validated.q;
      return { ...JUDGED_GOOD };
    }) as JudgeRunDeps['judgeSubmitFn'];

    const result = await runJudgeRun(db, data, META0, { judgeSubmitFn: capturing });
    expect(result.status).toBe('done');

    // Pre-fix this read the EDITED row and judged the learner against text they never saw.
    expect(captured.q).toBeDefined();
    expect(captured.q?.prompt_md).toBe(`Prompt for ${questionId}`);
    expect(captured.q?.reference_md).toBeNull();
    expect(captured.q?.difficulty).toBe(3);
    expect(captured.q?.knowledge_ids).toEqual(['k1']);

    // FSRS scheduled against the FROZEN knowledge tag, not the edited one.
    const fsrs = await db
      .select()
      .from(material_fsrs_state)
      .where(eq(material_fsrs_state.subject_id, 'k1'));
    expect(fsrs.length).toBeGreaterThan(0);
  });

  it('a payload with no snapshot (pre-snapshot in-flight job) still runs against the live row', async () => {
    const db = testDb();
    const questionId = `q_${newId()}`;
    await seedQuestion(questionId);
    const runId = newId();

    // jobData() intentionally omits question_snapshot.
    const result = await runJudgeRun(db, jobData(runId, questionId), META0, {
      judgeSubmitFn: mockJudgeSubmit(),
    });
    expect(result.status).toBe('done');
  });
});

// ── #1 (major) — duplicate-delivery race ────────────────────────────────────
// pg-boss can hand the same job to a second worker while the first is inside its LLM call.
// Both clear the entry guard; the winner commits; the loser's persistSubmit dies on the
// event PK. That must NOT terminalize the run as FAILED — the run was judged and persisted.
describe('runJudgeRun — duplicate-delivery race (#1)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  /** persistSubmit stand-in for the RACE LOSER: the winner's attempt row lands, then the PK blows up. */
  function losingPersist(runId: string, questionId: string): JudgeRunDeps['persistSubmitFn'] {
    return (async () => {
      // Worker A committed its backfill in the window between our entry guard and here.
      await testDb().insert(event).values({
        id: runId,
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'review',
        subject_kind: 'question',
        subject_id: questionId,
        outcome: 'success',
        payload: {},
      });
      throw new Error(
        `duplicate key value violates unique constraint "event_pkey" (id)=(${runId})`,
      );
    }) as JudgeRunDeps['persistSubmitFn'];
  }

  it('a PK conflict from the winning delivery recovers instead of writing a permanent FAILED', async () => {
    const db = testDb();
    const questionId = `q_${newId()}`;
    await seedQuestion(questionId);
    const runId = newId();

    const result = await runJudgeRun(db, jobData(runId, questionId), META0, {
      judgeSubmitFn: mockJudgeSubmit(),
      persistSubmitFn: losingPersist(runId, questionId),
    });

    // The loser recognises "already persisted" and recovers — it does not fail the run.
    expect(result.status).toBe('skipped');
    const events = await computeReplay(db, {
      businessTable: 'judge_run',
      businessId: runId,
      lastEventId: 0,
    });
    // Pre-fix: a terminal FAILED was written and, being the last terminal event, pinned
    // deriveJudgeRunStatus to 'failed' forever for a correctly judged submission.
    expect(events.some((e) => e.event_type === 'judge_run.failed')).toBe(false);
    expect(deriveJudgeRunStatus(events)).toBe('done');
  });

  it('does not overwrite the winner’s real verdict when its DONE already landed', async () => {
    const db = testDb();
    const questionId = `q_${newId()}`;
    await seedQuestion(questionId);
    const runId = newId();

    // Worker A ran to completion first (attempt + judge event + terminal DONE).
    await runJudgeRun(db, jobData(runId, questionId), META0, { judgeSubmitFn: mockJudgeSubmit() });

    // Worker B was already past its entry guard and now fails on the PK.
    const stillPersisted = (async () => {
      throw new Error('duplicate key value violates unique constraint "event_pkey"');
    }) as JudgeRunDeps['persistSubmitFn'];
    const second = await runJudgeRun(
      db,
      jobData(runId, questionId),
      { retryCount: 1, retryLimit: 2 },
      { judgeSubmitFn: mockJudgeSubmit(), persistSubmitFn: stillPersisted },
    );
    expect(second.status).toBe('skipped');

    const events = await computeReplay(db, {
      businessTable: 'judge_run',
      businessId: runId,
      lastEventId: 0,
    });
    expect(events.some((e) => e.event_type === 'judge_run.failed')).toBe(false);
    expect(deriveJudgeRunStatus(events)).toBe('done');
    // A's real verdict survives — no slim recovery DONE was appended over it.
    expect(events.filter((e) => e.event_type === 'judge_run.done')).toHaveLength(1);
    expect((terminalJudgeRunResult(events) as { coarse_outcome?: string })?.coarse_outcome).toBe(
      'correct',
    );
    // Exactly one attempt event and one judge event — no double-write.
    expect(await db.select().from(event).where(eq(event.id, runId))).toHaveLength(1);
  });
});

// ── #11 — per-job isolation in the batch loop ───────────────────────────────
describe('buildJudgeRunHandler — batch isolation (#11)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('a THROWING job does not abandon its batch-mates, and the batch still fails for redelivery', async () => {
    const db = testDb();
    const throwingQuestionId = `q_${newId()}`;
    const goodQuestionId = `q_${newId()}`;
    await seedQuestion(throwingQuestionId);
    await seedQuestion(goodQuestionId);
    const throwingRunId = newId();
    const goodRunId = newId();

    // Job 1's judge blows up with a RETRYABLE error → runJudgeRun rethrows. Pre-fix that
    // throw escaped the loop and job 2 never ran at all (pg-boss failed the whole batch).
    let call = 0;
    const failFirst = (async () => {
      call += 1;
      if (call === 1) throw new Error('endpoint down');
      return { ...JUDGED_GOOD };
    }) as JudgeRunDeps['judgeSubmitFn'];

    const handler = buildJudgeRunHandler(db, { judgeSubmitFn: failFirst });
    const jobs = [
      { id: 'j1', data: jobData(throwingRunId, throwingQuestionId), retryCount: 0, retryLimit: 2 },
      { id: 'j2', data: jobData(goodRunId, goodQuestionId), retryCount: 0, retryLimit: 2 },
    ] as unknown as Parameters<typeof handler>[0];

    // The batch STILL fails (retry semantics unchanged — pg-boss must redeliver job 1)…
    await expect(handler(jobs)).rejects.toThrow('endpoint down');

    // …but job 2 was drained and completed its backfill instead of being abandoned.
    expect(await db.select().from(event).where(eq(event.id, goodRunId))).toHaveLength(1);
    const goodEvents = await computeReplay(db, {
      businessTable: 'judge_run',
      businessId: goodRunId,
      lastEventId: 0,
    });
    expect(deriveJudgeRunStatus(goodEvents)).toBe('done');

    // Job 1 left its terminal FAILED trace.
    const failedEvents = await computeReplay(db, {
      businessTable: 'judge_run',
      businessId: throwingRunId,
      lastEventId: 0,
    });
    expect(deriveJudgeRunStatus(failedEvents)).toBe('failed');
  });
});
