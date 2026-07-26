// YUK-777 (A3) — domain-state-scan reconcile sweeper.
//
// The behaviour under test is "an answer that was recorded but never judged gets another
// dispatch, and nothing else does". Each case below pins one of the four ways the sweeper can
// decide, because getting any of them wrong is expensive in a different direction: a missed
// stall strands a learner's answer, and a spurious re-enqueue buys a duplicate paid judge.

import { newId } from '@/core/ids';
import { event, job_events, question } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { __resetRateLimitForTests } from '@/server/http/rate-limit';
import { eq } from 'drizzle-orm';
import type { JobWithMetadata } from 'pg-boss';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import {
  JUDGE_PENDING_ATTEMPT_ACTION,
  recordJudgePendingAttempt,
} from '../server/judge-run-dispatch';
import { JUDGE_RUN_EVENTS, JUDGE_RUN_TABLE } from '../server/judge-run-status';
import {
  MAX_RECOVERY_ATTEMPTS,
  RECONCILE_SCAN_LIMIT,
  RECONCILE_STALL_MS,
  RECOVERY_MAX_AGE_MS,
  reconcileStalledJudgeAttempts,
} from './judge_pending_reconcile';

const HOUR = 60 * 60_000;

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

/** Record a pending attempt as if it had been submitted `agoMs` ago. */
async function seedPendingAttempt(opts: { agoMs: number; runId?: string }) {
  const questionId = `q_${newId()}`;
  await seedQuestion(questionId);
  const runId = opts.runId ?? newId();
  const submittedAt = new Date(Date.now() - opts.agoMs);
  await recordJudgePendingAttempt(testDb(), {
    runId,
    sessionId: null,
    questionId,
    knowledgeIds: ['k1'],
    submit: {
      body: { question_id: questionId, rating: 'good', response_md: 'ans', auto_rate: true },
      question_id: questionId,
      subject_profile: { subject: 'wenyan' },
      question_snapshot: { kind: 'short_answer', prompt_md: 'p' },
      submitted_at: submittedAt.toISOString(),
    },
    submittedAt,
  });
  return { runId, questionId, submittedAt };
}

/** A boss whose jobs are all dead (the DLQ-exhausted / never-enqueued shape). */
function deadBoss() {
  const send = vi.fn().mockImplementation(async (_name, _data, options) => options?.id ?? newId());
  return {
    send,
    getJobById: vi.fn().mockResolvedValue(null as JobWithMetadata | null),
  };
}

describe('judge_pending_reconcile (YUK-777 A3)', () => {
  beforeEach(async () => {
    await resetDb();
    __resetRateLimitForTests();
    vi.unstubAllEnvs();
  });

  it('re-enqueues a stalled unjudged attempt, replaying the FROZEN payload verbatim', async () => {
    const { runId, questionId } = await seedPendingAttempt({ agoMs: RECONCILE_STALL_MS + HOUR });
    const boss = deadBoss();

    const report = await reconcileStalledJudgeAttempts(testDb(), { deps: { boss } });

    expect(report).toMatchObject({ scanned: 1, reenqueued: 1, failed: 0 });
    expect(boss.send).toHaveBeenCalledTimes(1);
    const [queue, data, options] = boss.send.mock.calls[0];
    expect(queue).toBe('judge_run');
    // Recovery gets a fresh deterministic pg-boss UUID rather than reusing the original. That
    // makes the delivery trackable and makes an uncertain retry of this recovery idempotent.
    expect(options).toEqual({ id: expect.any(String) });
    // Same run handle, same frozen inputs — a recovered run judges what the learner answered
    // and what the profile said THEN, not whatever those rows say now (D5 survives recovery).
    expect(data).toMatchObject({
      run_id: runId,
      caller: 'submit',
      submit: {
        question_id: questionId,
        subject_profile: { subject: 'wenyan' },
        question_snapshot: { kind: 'short_answer', prompt_md: 'p' },
      },
    });

    // …and it leaves the marker the next sweep counts against the recovery budget.
    const markers = await testDb()
      .select()
      .from(job_events)
      .where(eq(job_events.business_id, runId));
    expect(markers.map((m) => m.event_type)).toEqual([JUDGE_RUN_EVENTS.REQUEUED]);
    expect(markers[0].payload).toMatchObject({ attempt: 1, delivery_id: options.id });
  });

  it('tracks the latest recovery job and skips while it is still live', async () => {
    const { runId } = await seedPendingAttempt({ agoMs: RECONCILE_STALL_MS + HOUR });
    const boss = deadBoss();
    expect(await reconcileStalledJudgeAttempts(testDb(), { deps: { boss } })).toMatchObject({
      reenqueued: 1,
    });
    const recoveryId = boss.send.mock.calls[0][2]?.id;
    boss.getJobById.mockImplementation(async (_queue, id) =>
      id === recoveryId ? ({ state: 'active' } as JobWithMetadata) : null,
    );

    expect(await reconcileStalledJudgeAttempts(testDb(), { deps: { boss } })).toMatchObject({
      reenqueued: 0,
      skippedLive: 1,
    });
    expect(boss.getJobById).toHaveBeenLastCalledWith('judge_run', recoveryId);
    expect(boss.send).toHaveBeenCalledTimes(1);
  });

  it('never auto-requeues deliberate terminal FAILED/DLQ evidence', async () => {
    const { runId } = await seedPendingAttempt({ agoMs: RECONCILE_STALL_MS + HOUR });
    await testDb()
      .insert(job_events)
      .values({
        business_table: JUDGE_RUN_TABLE,
        business_id: runId,
        event_type: JUDGE_RUN_EVENTS.FAILED,
        payload: { reason: 'retries_exhausted' },
      });
    const boss = deadBoss();

    expect(await reconcileStalledJudgeAttempts(testDb(), { deps: { boss } })).toMatchObject({
      scanned: 1,
      reenqueued: 0,
      skippedTerminal: 1,
    });
    expect(boss.send).not.toHaveBeenCalled();
  });

  it.each(['failed', 'cancelled'] as const)(
    'treats pg-boss %s as manual-only rather than automatic recovery eligibility',
    async (state) => {
      await seedPendingAttempt({ agoMs: RECONCILE_STALL_MS + HOUR });
      const boss = {
        send: vi.fn(),
        getJobById: vi.fn().mockResolvedValue({ state } as JobWithMetadata),
      };

      expect(await reconcileStalledJudgeAttempts(testDb(), { deps: { boss } })).toMatchObject({
        reenqueued: 0,
        skippedTerminal: 1,
      });
      expect(boss.send).not.toHaveBeenCalled();
    },
  );

  it('leaves a JUDGED attempt alone — the review event keyed by run_id is the proof', async () => {
    const { runId, questionId } = await seedPendingAttempt({ agoMs: RECONCILE_STALL_MS + HOUR });
    // The backfill tx writes the review event with id = run_id. That is the whole
    // "was it judged?" predicate, and it is answerable without pg-boss or job_events.
    await writeEvent(testDb(), {
      id: runId,
      session_id: null,
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'review',
      subject_kind: 'question',
      subject_id: questionId,
      outcome: 'success',
      payload: {
        fsrs_rating: 'good',
        fsrs_state_after: {
          due: new Date().toISOString(),
          stability: 1,
          difficulty: 1,
          elapsed_days: 0,
          scheduled_days: 0,
          learning_steps: 0,
          reps: 1,
          lapses: 0,
          state: 'review',
          last_review: new Date().toISOString(),
        },
        user_response_md: 'ans',
        referenced_knowledge_ids: ['k1'],
      },
    });
    const boss = deadBoss();

    const report = await reconcileStalledJudgeAttempts(testDb(), { deps: { boss } });

    expect(report).toMatchObject({ scanned: 0, reenqueued: 0 });
    expect(boss.send).not.toHaveBeenCalled();
  });

  it('is not starved by a backlog of ALREADY-JUDGED attempts sitting in front of a stalled one', async () => {
    // Pending rows are immutable and never deleted, so judged ones pile up in front of the
    // unjudged. If the scan paged the oldest N and filtered afterwards, one ordinary week of
    // practice would push every genuinely stranded answer past the page and the sweeper would
    // report a clean sweep forever. The "was it judged?" test must be in the WHERE clause.
    for (let i = 0; i < RECONCILE_SCAN_LIMIT + 5; i++) {
      const seeded = await seedPendingAttempt({ agoMs: RECONCILE_STALL_MS + 10 * HOUR + i });
      await writeEvent(testDb(), {
        id: seeded.runId,
        session_id: null,
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'review',
        subject_kind: 'question',
        subject_id: seeded.questionId,
        outcome: 'success',
        payload: {
          fsrs_rating: 'good',
          fsrs_state_after: {
            due: new Date().toISOString(),
            stability: 1,
            difficulty: 1,
            elapsed_days: 0,
            scheduled_days: 0,
            learning_steps: 0,
            reps: 1,
            lapses: 0,
            state: 'review',
            last_review: new Date().toISOString(),
          },
          user_response_md: 'ans',
          referenced_knowledge_ids: ['k1'],
        },
      });
    }
    // The one that actually needs rescuing is the NEWEST, i.e. last in scan order.
    const { runId: stranded } = await seedPendingAttempt({ agoMs: RECONCILE_STALL_MS + HOUR });
    const boss = deadBoss();

    const report = await reconcileStalledJudgeAttempts(testDb(), { deps: { boss } });

    expect(report).toMatchObject({ scanned: 1, reenqueued: 1 });
    expect(boss.send.mock.calls[0][1]).toMatchObject({ run_id: stranded });
  });

  it('does not touch a run whose job can still progress (nor one pg-boss failed to report on)', async () => {
    await seedPendingAttempt({ agoMs: RECONCILE_STALL_MS + HOUR });

    const liveBoss = {
      send: vi.fn(),
      getJobById: vi.fn().mockResolvedValue({ state: 'active' } as JobWithMetadata),
    };
    expect(
      await reconcileStalledJudgeAttempts(testDb(), { deps: { boss: liveBoss } }),
    ).toMatchObject({ scanned: 1, reenqueued: 0, skippedLive: 1 });
    expect(liveBoss.send).not.toHaveBeenCalled();

    // A lookup that THREW is not evidence the run is dead. Waiting one more tick costs a few
    // minutes; re-enqueueing an in-flight run costs a duplicate paid judge.
    const blindBoss = {
      send: vi.fn(),
      getJobById: vi.fn().mockRejectedValue(new Error('pg-boss unreachable')),
    };
    expect(
      await reconcileStalledJudgeAttempts(testDb(), { deps: { boss: blindBoss } }),
    ).toMatchObject({ skippedLive: 1, reenqueued: 0 });
    expect(blindBoss.send).not.toHaveBeenCalled();
  });

  it('ignores an attempt that is younger than the stall threshold (a submit in flight right now)', async () => {
    await seedPendingAttempt({ agoMs: RECONCILE_STALL_MS - 60_000 });
    const boss = deadBoss();
    expect(await reconcileStalledJudgeAttempts(testDb(), { deps: { boss } })).toMatchObject({
      scanned: 0,
      reenqueued: 0,
    });
    expect(boss.send).not.toHaveBeenCalled();
  });

  it('stops after the automatic recovery budget, leaving the answer recorded for a human', async () => {
    const { runId } = await seedPendingAttempt({ agoMs: RECONCILE_STALL_MS + HOUR });
    const boss = deadBoss();

    for (let i = 0; i < MAX_RECOVERY_ATTEMPTS; i++) {
      expect(await reconcileStalledJudgeAttempts(testDb(), { deps: { boss } })).toMatchObject({
        reenqueued: 1,
      });
    }
    expect(boss.send).toHaveBeenCalledTimes(MAX_RECOVERY_ATTEMPTS);

    // Budget spent: the sweeper stops paying for a run that has failed every fresh dispatch.
    expect(await reconcileStalledJudgeAttempts(testDb(), { deps: { boss } })).toMatchObject({
      scanned: 1,
      reenqueued: 0,
      skippedExhausted: 1,
    });
    expect(boss.send).toHaveBeenCalledTimes(MAX_RECOVERY_ATTEMPTS);

    // Nothing was lost by stopping — the answer is still immutable evidence.
    const pending = await testDb()
      .select()
      .from(event)
      .where(eq(event.action, JUDGE_PENDING_ATTEMPT_ACTION));
    expect(pending).toHaveLength(1);
    expect((pending[0].payload as { run_id: string }).run_id).toBe(runId);
  });

  it('stops recovering past the age cap, where the requeue markers it counts have been pruned', async () => {
    await seedPendingAttempt({ agoMs: RECOVERY_MAX_AGE_MS + HOUR });
    const boss = deadBoss();
    expect(await reconcileStalledJudgeAttempts(testDb(), { deps: { boss } })).toMatchObject({
      scanned: 0,
      reenqueued: 0,
    });
    expect(boss.send).not.toHaveBeenCalled();
  });

  it('a throttled or unavailable queue defers the run instead of dropping it', async () => {
    const { runId } = await seedPendingAttempt({ agoMs: RECONCILE_STALL_MS + HOUR });
    const boss = {
      send: vi.fn().mockRejectedValue(new Error('boss down')),
      getJobById: vi.fn().mockResolvedValue(null as JobWithMetadata | null),
    };

    expect(await reconcileStalledJudgeAttempts(testDb(), { deps: { boss } })).toMatchObject({
      scanned: 1,
      reenqueued: 0,
      failed: 1,
    });
    // No marker written ⇒ no recovery attempt was consumed by a dispatch that never happened.
    // `job_events` is not truncated by resetDb, so assert a DELTA (rows for THIS run).
    expect(
      await testDb().select().from(job_events).where(eq(job_events.business_id, runId)),
    ).toHaveLength(0);

    // Next tick, with a healthy queue, it goes through.
    const healthy = deadBoss();
    expect(
      await reconcileStalledJudgeAttempts(testDb(), { deps: { boss: healthy } }),
    ).toMatchObject({ reenqueued: 1 });
  });

  it('re-enqueues through the rate-limited face — an exhausted budget defers, never bypasses', async () => {
    await seedPendingAttempt({ agoMs: RECONCILE_STALL_MS + HOUR });
    const boss = deadBoss();
    const exhausted = vi.fn().mockImplementation(() => {
      throw new Error('rate limited');
    });

    expect(
      await reconcileStalledJudgeAttempts(testDb(), {
        deps: { boss, checkRateLimit: exhausted },
      }),
    ).toMatchObject({ reenqueued: 0, failed: 1 });
    // The whole point: recovery is a PRODUCER of paid inference, so it must be unable to
    // reach the queue without passing the same budget gate the submit route passes.
    expect(exhausted).toHaveBeenCalledTimes(1);
    expect(boss.send).not.toHaveBeenCalled();
  });
});
