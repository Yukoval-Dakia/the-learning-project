// YUK-594 (durable judge main path, W1) — judge_run handler DB tests.
//
// Covers: enqueue→judge→single-tx backfill (attempt review event id=run_id + judge
// event + FSRS advance + terminal DONE); idempotent re-delivery does not double-write;
// judge failure writes a terminal FAILED trace AND rethrows for pg-boss re-delivery;
// a non-retryable caller writes FAILED without rethrowing. The judge itself is mocked
// at the judgeSubmit seam (no LLM call); the REAL persistSubmit runs the backfill tx.

import { newId } from '@/core/ids';
import { event, job_events, mastery_state, material_fsrs_state, question } from '@/db/schema';
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

  // W4 #TtWiB — a RETRYABLE failure with budget left must leave a NON-terminal trace.
  // Pre-fix it wrote terminal FAILED, so poll/SSE clients correctly concluded the run was
  // dead and stopped waiting — while pg-boss had a redelivery queued that would likely
  // write DONE. The run must stay 'started' until the budget is actually spent.
  it('a RETRYABLE judge failure leaves a non-terminal trace (run stays in flight) and rethrows', async () => {
    const db = testDb();
    const questionId = `q_${newId()}`;
    await seedQuestion(questionId);
    const runId = newId();

    const boom = (async () => {
      throw new Error('endpoint down');
    }) as JudgeRunDeps['judgeSubmitFn'];

    // retryCount 0 < retryLimit 2 → pg-boss will deliver this job again.
    await expect(
      runJudgeRun(db, jobData(runId, questionId), META0, { judgeSubmitFn: boom }),
    ).rejects.toThrow('endpoint down');

    // no attempt persisted (backfill never reached).
    const attempts = await db.select().from(event).where(eq(event.id, runId));
    expect(attempts).toHaveLength(0);

    const events = await computeReplay(db, {
      businessTable: 'judge_run',
      businessId: runId,
      lastEventId: 0,
    });
    // The failure IS recorded (observable, SSE can render "retrying")…
    expect(events.some((e) => e.event_type === 'judge_run.attempt_failed')).toBe(true);
    // …but NOT as a terminal event: no FAILED, and the derived status keeps clients waiting.
    expect(events.some((e) => e.event_type === 'judge_run.failed')).toBe(false);
    expect(deriveJudgeRunStatus(events)).toBe('started');
  });

  it('the FINAL delivery (budget spent) writes the terminal FAILED', async () => {
    const db = testDb();
    const questionId = `q_${newId()}`;
    await seedQuestion(questionId);
    const runId = newId();

    const boom = (async () => {
      throw new Error('endpoint down');
    }) as JudgeRunDeps['judgeSubmitFn'];

    // retryCount === retryLimit → no further delivery; next stop is judge_run_dlq.
    await expect(
      runJudgeRun(
        db,
        jobData(runId, questionId),
        { retryCount: 2, retryLimit: 2 },
        {
          judgeSubmitFn: boom,
        },
      ),
    ).rejects.toThrow('endpoint down');

    const events = await computeReplay(db, {
      businessTable: 'judge_run',
      businessId: runId,
      lastEventId: 0,
    });
    expect(deriveJudgeRunStatus(events)).toBe('failed');
    expect(
      (events.find((e) => e.event_type === 'judge_run.failed')?.payload as { reason?: string })
        ?.reason,
    ).toBe('retries_exhausted');
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
  it('failure payloads carry a classified code, NOT the raw error message (both tiers)', async () => {
    const db = testDb();
    const questionId = `q_${newId()}`;
    await seedQuestion(questionId);
    const secret = 'connection to 10.0.0.7:5432 refused (/srv/app/internal/path.ts)';
    const boom = (async () => {
      throw new Error(secret);
    }) as JudgeRunDeps['judgeSubmitFn'];

    // Both the non-terminal retry trace and the terminal one ride the generic SSE face
    // verbatim, so BOTH must be redacted.
    const retryableRunId = newId();
    await expect(
      runJudgeRun(db, jobData(retryableRunId, questionId), META0, { judgeSubmitFn: boom }),
    ).rejects.toThrow(secret);
    const terminalRunId = newId();
    await expect(
      runJudgeRun(
        db,
        jobData(terminalRunId, questionId),
        { retryCount: 2, retryLimit: 2 },
        {
          judgeSubmitFn: boom,
        },
      ),
    ).rejects.toThrow(secret);

    const replay = async (runId: string) =>
      await computeReplay(db, { businessTable: 'judge_run', businessId: runId, lastEventId: 0 });

    const attemptFailed = (await replay(retryableRunId)).find(
      (e) => e.event_type === 'judge_run.attempt_failed',
    );
    const attemptPayload = attemptFailed?.payload as Record<string, unknown>;
    expect(attemptPayload.error_code).toBe('judge_failed');

    const failed = (await replay(terminalRunId)).find((e) => e.event_type === 'judge_run.failed');
    const payload = failed?.payload as Record<string, unknown>;
    expect(payload.reason).toBe('retries_exhausted');
    expect(payload.error_code).toBe('judge_failed');

    // The client-facing payloads must not contain the raw message under ANY key.
    for (const p of [attemptPayload, payload]) {
      expect(JSON.stringify(p)).not.toContain('10.0.0.7');
      expect(JSON.stringify(p)).not.toContain('/srv/app/internal');
    }
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

// ── W4 #TtWiA (codex P1) — out-of-order FSRS/θ̂ backfill ────────────────────
// The durable lane decouples "when the learner answered" from "when the verdict lands". An
// earlier run whose judge failed goes into 30s/60s redelivery while a LATER attempt on the
// same KC succeeds first; the older run then arrives carrying an EARLIER submitted_at and
// reschedules on top of the newer state. The tx lock serializes writes but cannot restore
// time order, so last_review / due / θ̂ / snapshots all get walked backwards.
describe('runJudgeRun — late-arriving backfill (#TtWiA)', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('records the late attempt but does NOT regress FSRS or θ̂', async () => {
    const db = testDb();
    const questionId = `q_${newId()}`;
    await seedQuestion(questionId);

    // The NEWER attempt lands first (its run succeeded while the older one was retrying).
    const newerRunId = newId();
    const newerData = jobData(newerRunId, questionId);
    newerData.submit.submitted_at = new Date('2026-07-20T10:00:00Z').toISOString();
    await runJudgeRun(db, newerData, META0, { judgeSubmitFn: mockJudgeSubmit() });

    const afterNewer = (
      await db.select().from(material_fsrs_state).where(eq(material_fsrs_state.subject_id, 'k1'))
    )[0];
    expect(afterNewer).toBeTruthy();
    const thetaAfterNewer = (
      await db.select().from(mastery_state).where(eq(mastery_state.subject_id, 'k1'))
    )[0]?.theta_hat;

    // Now the OLDER run finally succeeds on redelivery, with an earlier answer timestamp.
    const olderRunId = newId();
    const olderData = jobData(olderRunId, questionId);
    olderData.submit.submitted_at = new Date('2026-07-20T09:00:00Z').toISOString();
    const result = await runJudgeRun(db, olderData, META0, { judgeSubmitFn: mockJudgeSubmit() });
    expect(result.status).toBe('done');

    // The attempt IS recorded — it is immutable evidence and must never be dropped.
    expect(await db.select().from(event).where(eq(event.id, olderRunId))).toHaveLength(1);

    // …but the schedule was NOT walked backwards onto the older attempt.
    const afterOlder = (
      await db.select().from(material_fsrs_state).where(eq(material_fsrs_state.subject_id, 'k1'))
    )[0];
    expect(afterOlder.due_at.getTime()).toBe(afterNewer.due_at.getTime());
    expect(afterOlder.last_review_event_id).toBe(afterNewer.last_review_event_id);
    // θ̂ is equally order-sensitive and is skipped on the same branch.
    const thetaAfterOlder = (
      await db.select().from(mastery_state).where(eq(mastery_state.subject_id, 'k1'))
    )[0]?.theta_hat;
    expect(thetaAfterOlder).toBe(thetaAfterNewer);

    // And NO revert bracket is minted for the late attempt. writeAttemptSnapshotBrackets
    // writes a segment iff its snapshot ARRAY is non-empty (not iff before !== after), so
    // passing the unchanged updates through would create a checkpoint + snapshot describing
    // a transition that never happened — reversible state for a no-op.
    const brackets = await db.select().from(event).where(eq(event.subject_id, olderRunId));
    expect(brackets.map((e) => e.action)).not.toContain('experimental:state_snapshot');
    expect(brackets.map((e) => e.action)).not.toContain('experimental:grading_checkpoint');

    // W5 #TuezA — the POST-COMMIT mastery-progress signal must be skipped too. It reads
    // `mastery_state.last_theta_delta` after commit and reports it as THIS attempt's Δθ̂ with
    // caused_by pointing here; since θ̂ was deliberately not updated, that delta belongs to
    // the NEWER attempt, so emitting it manufactures mis-attributed experiment data.
    const signals = await db
      .select()
      .from(event)
      .where(eq(event.action, 'experimental:mastery_progress'));
    expect(signals.some((e) => e.caused_by_event_id === olderRunId)).toBe(false);

    // The terminal DONE records that the schedule intentionally did not move.
    const events = await computeReplay(db, {
      businessTable: 'judge_run',
      businessId: olderRunId,
      lastEventId: 0,
    });
    expect((terminalJudgeRunResult(events) as { late_arrival?: boolean })?.late_arrival).toBe(true);
  });

  // W5 #Tuey8 — the detection domain must cover EVERY write domain, not just the FSRS subset.
  // θ̂ is written for the question's FULL knowledge_ids, while FSRS writes only
  // `requested ∩ labels`. A newer attempt that advanced a KC OUTSIDE this attempt's FSRS
  // subset used to slip past a detector that only walked the FSRS updates.
  it('detects lateness from a KC that only the θ̂ write set covers', async () => {
    const db = testDb();
    const questionId = `q_${newId()}`;
    const now = new Date();
    // Two labels: the submit below narrows FSRS to k1 via referenced_knowledge_ids, but θ̂
    // still writes BOTH k1 and k2.
    await db.insert(question).values({
      id: questionId,
      prompt_md: `Prompt for ${questionId}`,
      kind: 'short_answer',
      reference_md: null,
      knowledge_ids: ['k1', 'k2'],
      difficulty: 3,
      source: 'manual',
      variant_depth: 0,
      version: 0,
      created_at: now,
      updated_at: now,
    });

    // A newer attempt already moved θ̂ for k2 ONLY (nothing touched k1's FSRS card).
    await db.insert(mastery_state).values({
      id: newId(),
      subject_kind: 'knowledge',
      subject_id: 'k2',
      theta_hat: 0.5,
      evidence_count: 1,
      last_outcome_at: new Date('2026-07-20T10:00:00Z'),
      updated_at: new Date('2026-07-20T10:00:00Z'),
    });

    // The late run narrows FSRS to k1, so an FSRS-only detector sees nothing stale.
    const olderRunId = newId();
    const olderData = jobData(olderRunId, questionId);
    olderData.submit.submitted_at = new Date('2026-07-20T09:00:00Z').toISOString();
    (olderData.submit.body as { referenced_knowledge_ids?: string[] }).referenced_knowledge_ids = [
      'k1',
    ];

    const result = await runJudgeRun(db, olderData, META0, { judgeSubmitFn: mockJudgeSubmit() });
    expect(result.status).toBe('done');
    // Evidence recorded…
    expect(await db.select().from(event).where(eq(event.id, olderRunId))).toHaveLength(1);
    // …but k2's θ̂ was NOT moved backwards by the stale attempt.
    const k2 = (await db.select().from(mastery_state).where(eq(mastery_state.subject_id, 'k2')))[0];
    expect(k2.theta_hat).toBe(0.5);
    expect(k2.evidence_count).toBe(1);
    // …and no FSRS card was created for k1 either (whole-attempt skip, not a partial one).
    expect(
      await db.select().from(material_fsrs_state).where(eq(material_fsrs_state.subject_id, 'k1')),
    ).toHaveLength(0);
  });

  it('an IN-ORDER backfill still advances FSRS normally (the guard is not a blanket skip)', async () => {
    const db = testDb();
    const questionId = `q_${newId()}`;
    await seedQuestion(questionId);

    const firstRunId = newId();
    const firstData = jobData(firstRunId, questionId);
    firstData.submit.submitted_at = new Date('2026-07-20T09:00:00Z').toISOString();
    await runJudgeRun(db, firstData, META0, { judgeSubmitFn: mockJudgeSubmit() });
    const afterFirst = (
      await db.select().from(material_fsrs_state).where(eq(material_fsrs_state.subject_id, 'k1'))
    )[0];

    const secondRunId = newId();
    const secondData = jobData(secondRunId, questionId);
    secondData.submit.submitted_at = new Date('2026-07-20T10:00:00Z').toISOString();
    await runJudgeRun(db, secondData, META0, { judgeSubmitFn: mockJudgeSubmit() });
    const afterSecond = (
      await db.select().from(material_fsrs_state).where(eq(material_fsrs_state.subject_id, 'k1'))
    )[0];

    // The later attempt owns the schedule now.
    expect(afterSecond.last_review_event_id).toBe(secondRunId);
    expect(afterSecond.last_review_event_id).not.toBe(afterFirst.last_review_event_id);
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

    // Job 1 left a NON-terminal failure trace — it still has retry budget (W4 #TtWiB), so
    // it must not be reported as dead while pg-boss has a redelivery queued.
    const failedEvents = await computeReplay(db, {
      businessTable: 'judge_run',
      businessId: throwingRunId,
      lastEventId: 0,
    });
    expect(failedEvents.some((e) => e.event_type === 'judge_run.attempt_failed')).toBe(true);
    expect(deriveJudgeRunStatus(failedEvents)).toBe('started');
  });

  // W4 #TtZ8i (OCR major) — a malformed job used to be silently `continue`d, which pg-boss
  // treats as a successful consume: the job vanished with NO terminal event, stranding the
  // run pending forever, and `runJudgeRun`'s own malformed-payload guard never even ran.
  it('a malformed job WITH a run_id is terminalized instead of silently dropped', async () => {
    const db = testDb();
    const runId = newId();
    const handler = buildJudgeRunHandler(db);
    const jobs = [
      { id: 'j-malformed', data: { run_id: runId }, retryCount: 0, retryLimit: 2 },
    ] as unknown as Parameters<typeof handler>[0];

    // Terminalized, so the batch is consumed (a redelivery could not improve a bad payload).
    await handler(jobs);

    const events = await computeReplay(db, {
      businessTable: 'judge_run',
      businessId: runId,
      lastEventId: 0,
    });
    expect(deriveJudgeRunStatus(events)).toBe('failed');
    const payload = events.find((e) => e.event_type === 'judge_run.failed')?.payload as {
      reason?: string;
      error_code?: string;
    };
    expect(payload?.reason).toBe('non_retryable');
    expect(payload?.error_code).toBe('invalid_payload');
  });

  it('a malformed job with NO run_id fails the batch so pg-boss routes it to the DLQ', async () => {
    const db = testDb();
    const handler = buildJudgeRunHandler(db);
    const jobs = [
      { id: 'j-no-run-id', data: { caller: 'submit' }, retryCount: 0, retryLimit: 2 },
    ] as unknown as Parameters<typeof handler>[0];

    // Nothing to terminalize against → the ONLY honest move is to fail the job, so the
    // malformed payload becomes visible to an operator in the DLQ rather than disappearing.
    await expect(handler(jobs)).rejects.toThrow('missing run_id');
  });
});
