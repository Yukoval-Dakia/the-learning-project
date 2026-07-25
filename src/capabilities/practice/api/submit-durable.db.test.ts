// YUK-594 (durable judge main path, W2) — submit-face async-main divert tests.
//
// Covers: flag-OFF byte-identical anchor (no 202, normal review_event shape); the
// divert predicate (resolveDurableDivert mirrors judgeSubmit's server-invoke gate);
// and enqueueDurableJudge's 202-pending contract + queued job_event + frozen payload.

import { newId } from '@/core/ids';
import { event, job_events, learning_session, question } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { computeReplay } from '@/server/events/sse_replay';
import { writeJobEvent } from '@/server/events/writer';
import { __resetRateLimitForTests } from '@/server/http/rate-limit';
import { resolveSubjectProfile } from '@/subjects/profile';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { normalizeReviewSubmitActivityRef } from '../server/activity-ref';
import { deriveJudgeRunStatus } from '../server/judge-run-status';
import { CreateAttemptBodySchema } from './contracts';
import { createAttempt, enqueueDurableJudge, resolveDurableDivert } from './submit';

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

async function buildValidated(questionId: string, body: Record<string, unknown>) {
  const parsed = CreateAttemptBodySchema.parse({ question_id: questionId, ...body });
  const q = (await testDb().select().from(question).where(eq(question.id, questionId)))[0];
  return {
    body: parsed,
    now: new Date(),
    questionId,
    activityRef: normalizeReviewSubmitActivityRef(parsed).activity_ref,
    q,
  };
}

describe('submit durable divert (W2)', () => {
  beforeEach(async () => {
    await resetDb();
    __resetRateLimitForTests();
    vi.unstubAllEnvs();
  });

  it('flag-OFF: manual submit stays synchronous — 200 with the normal review_event shape (byte-identical anchor)', async () => {
    const questionId = `q_${newId()}`;
    await seedQuestion(questionId);
    // JUDGE_DURABLE_ENABLED unset → the durable block is skipped entirely.
    const res = await createAttempt(
      new Request('http://localhost/api/review/submit', {
        method: 'POST',
        body: JSON.stringify({ question_id: questionId, rating: 'good' }),
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { review_event?: { id: string }; verdict?: string };
    expect(json.review_event?.id).toBeTruthy();
    expect(json.verdict).toBeUndefined(); // NOT a pending contract.
  });

  it('resolveDurableDivert diverts an auto_rate text answer, and declines the non-judge cases', async () => {
    const questionId = `q_${newId()}`;
    await seedQuestion(questionId);

    // auto_rate + a text answer → would spend a synchronous server judge call → divert.
    const divertCase = await resolveDurableDivert(
      await buildValidated(questionId, { rating: 'good', response_md: 'ans', auto_rate: true }),
    );
    expect(divertCase.divert).toBe(true);
    expect(divertCase.subjectProfile).not.toBeNull();

    // auto_rate=false (manual) → no LLM call → no divert.
    expect(
      (await resolveDurableDivert(await buildValidated(questionId, { rating: 'good' }))).divert,
    ).toBe(false);

    // no answer → sync 422 path, not divert.
    expect(
      (
        await resolveDurableDivert(
          await buildValidated(questionId, { rating: 'good', auto_rate: true }),
        )
      ).divert,
    ).toBe(false);

    // client-supplied verdict → already judged, no LLM call → no divert.
    const supplied = await resolveDurableDivert(
      await buildValidated(questionId, {
        rating: 'good',
        response_md: 'ans',
        auto_rate: true,
        judge_result_v2: {
          coarse_outcome: 'correct',
          score: 1,
          score_meaning: 'correctness',
          confidence: 0.9,
          capability_ref: { id: 'exact', version: '1.0.0' },
          feedback_md: 'ok',
          evidence_json: {},
        },
      }),
    );
    expect(supplied.divert).toBe(false);
  });

  it('enqueueDurableJudge returns 202-pending + writes the queued marker + freezes the profile in the payload', async () => {
    const db = testDb();
    const questionId = `q_${newId()}`;
    await seedQuestion(questionId);
    const validated = await buildValidated(questionId, {
      rating: 'good',
      response_md: 'ans',
      auto_rate: true,
      session_id: 's1',
    });
    const profile = resolveSubjectProfile();
    const send = vi.fn().mockResolvedValue('job-1');

    const res = await enqueueDurableJudge(validated, profile, { boss: { send } });
    expect(res.status).toBe(202);
    const body = (await res.json()) as {
      run_id: string;
      verdict: string;
      backfill: { channel: string; url: string; poll_url: string };
    };
    expect(body.verdict).toBe('pending');
    expect(body.backfill.channel).toBe('sse');
    expect(body.backfill.url).toBe(`/api/jobs/judge_run/${body.run_id}/events`);
    expect(body.backfill.poll_url).toBe(`/api/jobs/judge_run/${body.run_id}/status`);
    expect(res.headers.get('Location')).toBe(`/api/jobs/judge_run/${body.run_id}/events`);

    // queued marker committed → status derives to queued.
    const events = await computeReplay(db, {
      businessTable: 'judge_run',
      businessId: body.run_id,
      lastEventId: 0,
    });
    expect(deriveJudgeRunStatus(events)).toBe('queued');

    // job enqueued with the frozen submit inputs (D5 profile frozen into payload).
    expect(send).toHaveBeenCalledTimes(1);
    const [queueName, payload] = send.mock.calls[0] as [
      string,
      { run_id: string; caller: string; submit: { question_id: string; subject_profile: unknown } },
    ];
    expect(queueName).toBe('judge_run');
    expect(payload.run_id).toBe(body.run_id);
    expect(payload.caller).toBe('submit');
    expect(payload.submit.question_id).toBe(questionId);
    expect(payload.submit.subject_profile).toBeTruthy();
    // #2 (codex) — the question the learner ANSWERED rides the payload too, so a later
    // edit to the row can't retroactively change what gets judged/scheduled.
    const snapshot = (payload.submit as { question_snapshot?: Record<string, unknown> })
      .question_snapshot;
    expect(snapshot).toBeTruthy();
    expect(snapshot?.prompt_md).toBe(`Prompt for ${questionId}`);
    expect(snapshot?.knowledge_ids).toEqual(['k1']);
    expect(snapshot?.difficulty).toBe(3);

    // #8 — the divert response carries an EXPLICIT discriminant, not just a bare 202.
    expect(res.headers.get('x-durable-divert')).toBe('judge');

    // no attempt event exists yet (worker persists it on backfill).
    expect(await db.select().from(event).where(eq(event.id, body.run_id))).toHaveLength(0);
  });

  it('send-first: a boss.send failure writes NO durable state (no stuck-queued marker, no attempt)', async () => {
    const db = testDb();
    const questionId = `q_${newId()}`;
    await seedQuestion(questionId);
    const validated = await buildValidated(questionId, {
      rating: 'good',
      response_md: 'ans',
      auto_rate: true,
    });
    const send = vi.fn().mockRejectedValue(new Error('boss down'));

    // job_events is not truncated by resetDb — assert a DELTA of 0 (no new marker),
    // pollution-proof against markers other tests in this file left behind.
    const before = (await db.select().from(job_events)).length;
    const res = await enqueueDurableJudge(validated, resolveSubjectProfile(), { boss: { send } });
    expect(res.status).toBeGreaterThanOrEqual(500);
    // Send-first: the marker is written AFTER a successful send, so a send failure
    // writes NO new job_events — nothing sits stuck queued, nothing to compensate.
    expect(await db.select().from(job_events)).toHaveLength(before);
  });

  it('a null boss.send (dedupe/no-job) is treated as a failed enqueue (503, no new marker)', async () => {
    const db = testDb();
    const questionId = `q_${newId()}`;
    await seedQuestion(questionId);
    const validated = await buildValidated(questionId, {
      rating: 'good',
      response_md: 'ans',
      auto_rate: true,
    });
    const before = (await db.select().from(job_events)).length;
    const send = vi.fn().mockResolvedValue(null);
    const res = await enqueueDurableJudge(validated, resolveSubjectProfile(), { boss: { send } });
    expect(res.status).toBe(503);
    expect(await db.select().from(job_events)).toHaveLength(before);
  });

  it('rate-limits the durable enqueue on the shared paid-AI budget (does not send when over budget)', async () => {
    const questionId = `q_${newId()}`;
    await seedQuestion(questionId);
    const validated = await buildValidated(questionId, {
      rating: 'good',
      response_md: 'ans',
      auto_rate: true,
    });
    // Exhaust the in-process budget (default max 30) BEFORE the enqueue.
    vi.stubEnv('AI_RATE_LIMIT_MAX', '1');
    const { checkRateLimit } = await import('@/server/http/rate-limit');
    checkRateLimit(); // fills the single slot
    const send = vi.fn().mockResolvedValue('job-1');
    const res = await enqueueDurableJudge(validated, resolveSubjectProfile(), { boss: { send } });
    expect(res.status).toBe(429);
    expect(send).not.toHaveBeenCalled();
  });

  // #9 — the budget gate is injectable like `boss`/`now`, so the over-budget branch is
  // reachable without module-mocking '@/server/http/rate-limit'.
  it('honours an injected checkRateLimit seam (no send when the gate throws)', async () => {
    const questionId = `q_${newId()}`;
    await seedQuestion(questionId);
    const validated = await buildValidated(questionId, {
      rating: 'good',
      response_md: 'ans',
      auto_rate: true,
    });
    const send = vi.fn().mockResolvedValue('job-1');
    const gate = vi.fn(() => {
      throw new ApiError('rate_limited', 'over budget', 429);
    });
    const res = await enqueueDurableJudge(validated, resolveSubjectProfile(), {
      boss: { send },
      checkRateLimit: gate,
    });
    expect(gate).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(429);
    expect(send).not.toHaveBeenCalled();
  });
});

// ── W4 #TtWh_ (codex P1) — the shared /api/attempts entry point ────────────────────
// The placement probe posts through the SAME route with auto_rate:true, then immediately
// calls /question-selections for the next item. placement-next computes the answered set
// from PERSISTED review/attempt events, so under a 202 the just-answered question is not in
// the exclusion set: answeredCount stalls and the probe can re-serve it. W2's divert was
// written for the practice face; this shared entry point was the leak.
describe('submit durable divert — session gate (#TtWh_)', () => {
  beforeEach(async () => {
    await resetDb();
    __resetRateLimitForTests();
    vi.unstubAllEnvs();
  });

  async function seedSession(type: string): Promise<string> {
    const sessionId = newId();
    const now = new Date();
    await testDb()
      .insert(learning_session)
      .values({
        id: sessionId,
        type,
        status: type === 'placement' ? 'started' : 'started',
        warnings: [],
        created_at: now,
        updated_at: now,
        version: 0,
      });
    return sessionId;
  }

  it('a PLACEMENT session does NOT divert (the probe needs a persisted verdict before /next)', async () => {
    const questionId = `q_${newId()}`;
    await seedQuestion(questionId);
    const sessionId = await seedSession('placement');
    const gate = await resolveDurableDivert(
      await buildValidated(questionId, {
        rating: 'good',
        response_md: 'ans',
        auto_rate: true,
        session_id: sessionId,
      }),
    );
    expect(gate.divert).toBe(false);
    // The profile still resolves — only the async protocol is withheld, and the caller
    // reuses the profile for the synchronous judge.
    expect(gate.subjectProfile).not.toBeNull();
  });

  it('a REVIEW session diverts (the practice face is W2 scope)', async () => {
    const questionId = `q_${newId()}`;
    await seedQuestion(questionId);
    const sessionId = await seedSession('review');
    const gate = await resolveDurableDivert(
      await buildValidated(questionId, {
        rating: 'good',
        response_md: 'ans',
        auto_rate: true,
        session_id: sessionId,
      }),
    );
    expect(gate.divert).toBe(true);
  });

  it('no session_id (ad-hoc solo practice) diverts', async () => {
    const questionId = `q_${newId()}`;
    await seedQuestion(questionId);
    const gate = await resolveDurableDivert(
      await buildValidated(questionId, { rating: 'good', response_md: 'ans', auto_rate: true }),
    );
    expect(gate.divert).toBe(true);
  });

  it('fails CLOSED: an unadmitted session type and an unknown session id both stay synchronous', async () => {
    const questionId = `q_${newId()}`;
    await seedQuestion(questionId);
    // The gate is an allowlist, so a future caller mounting on this shared route cannot
    // silently inherit the async contract — it has to opt in explicitly.
    const conversationSession = await seedSession('conversation');
    expect(
      (
        await resolveDurableDivert(
          await buildValidated(questionId, {
            rating: 'good',
            response_md: 'ans',
            auto_rate: true,
            session_id: conversationSession,
          }),
        )
      ).divert,
    ).toBe(false);
    expect(
      (
        await resolveDurableDivert(
          await buildValidated(questionId, {
            rating: 'good',
            response_md: 'ans',
            auto_rate: true,
            session_id: `unknown_${newId()}`,
          }),
        )
      ).divert,
    ).toBe(false);
  });
});

// ── W4 #TtWiC — a repeat answer is a REAL attempt, never a deduped retry ────────────
// Round 3 added a 120s (question_id, answer_hash) dedupe as a stand-in for request
// idempotency. Without a stable per-request key it could not tell a lost-202 retry from a
// genuine re-answer, and PfSolo explicitly supports re-answering the same question — so it
// silently swallowed real attempts: no second run, no immutable attempt row, no FSRS advance.
// These tests pin the reverted behaviour so the shortcut cannot come back.
describe('submit durable enqueue — repeat answers are real attempts (#TtWiC)', () => {
  beforeEach(async () => {
    await resetDb();
    __resetRateLimitForTests();
    vi.unstubAllEnvs();
  });

  it('re-answering the same question with the SAME text enqueues its own run', async () => {
    const questionId = `q_${newId()}`;
    await seedQuestion(questionId);
    const body = { rating: 'good', response_md: 'ans', auto_rate: true, session_id: 's1' };
    const send = vi.fn().mockResolvedValue('job-1');

    const first = await enqueueDurableJudge(
      await buildValidated(questionId, body),
      resolveSubjectProfile(),
      { boss: { send } },
    );
    // A learner re-practising the same item, seconds later, with an identical answer.
    const second = await enqueueDurableJudge(
      await buildValidated(questionId, body),
      resolveSubjectProfile(),
      { boss: { send } },
    );

    const firstRunId = ((await first.json()) as { run_id: string }).run_id;
    const secondRunId = ((await second.json()) as { run_id: string }).run_id;
    // Distinct runs → two attempts → FSRS advances twice, which is the correct product
    // behaviour. The dedupe collapsed these into one run and dropped the second attempt.
    expect(secondRunId).not.toBe(firstRunId);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('pins the run handle to the pg-boss job id so a marker-less run stays resolvable', async () => {
    const questionId = `q_${newId()}`;
    await seedQuestion(questionId);
    const send = vi.fn().mockResolvedValue('job-1');
    const res = await enqueueDurableJudge(
      await buildValidated(questionId, { rating: 'good', response_md: 'ans', auto_rate: true }),
      resolveSubjectProfile(),
      { boss: { send } },
    );
    const { run_id } = (await res.json()) as { run_id: string };
    // W4 #TtWiD — the poll route resolves a marker-less run via boss.getJobById(queue, runId),
    // which only works because the enqueue pins SendOptions.id to the run handle.
    expect(send.mock.calls[0]?.[2]).toEqual({ id: run_id });
  });
});

// ── W4 #TtZ8e/#TtZ8k (OCR major) — a failed enqueue must not burn paid-AI budget ────
describe('submit durable enqueue — rate-limit token refund', () => {
  beforeEach(async () => {
    await resetDb();
    __resetRateLimitForTests();
    vi.unstubAllEnvs();
  });

  it('refunds the budget token when boss.send throws', async () => {
    const questionId = `q_${newId()}`;
    await seedQuestion(questionId);
    const validated = await buildValidated(questionId, {
      rating: 'good',
      response_md: 'ans',
      auto_rate: true,
    });
    // A single-slot window makes the leak observable: pre-fix the failed send consumed the
    // only token, so the NEXT (healthy) enqueue was 429'd by a job that never existed.
    vi.stubEnv('AI_RATE_LIMIT_MAX', '1');
    const failing = vi.fn().mockRejectedValue(new Error('boss down'));
    const failed = await enqueueDurableJudge(validated, resolveSubjectProfile(), {
      boss: { send: failing },
    });
    expect(failed.status).toBeGreaterThanOrEqual(500);

    const healthy = vi.fn().mockResolvedValue('job-1');
    const retry = await enqueueDurableJudge(validated, resolveSubjectProfile(), {
      boss: { send: healthy },
    });
    expect(retry.status).toBe(202);
    expect(healthy).toHaveBeenCalledTimes(1);
  });

  it('refunds the budget token when boss.send returns null (nothing enqueued)', async () => {
    const questionId = `q_${newId()}`;
    await seedQuestion(questionId);
    const validated = await buildValidated(questionId, {
      rating: 'good',
      response_md: 'ans',
      auto_rate: true,
    });
    vi.stubEnv('AI_RATE_LIMIT_MAX', '1');
    const nullSend = vi.fn().mockResolvedValue(null);
    expect(
      (await enqueueDurableJudge(validated, resolveSubjectProfile(), { boss: { send: nullSend } }))
        .status,
    ).toBe(503);

    const healthy = vi.fn().mockResolvedValue('job-1');
    expect(
      (await enqueueDurableJudge(validated, resolveSubjectProfile(), { boss: { send: healthy } }))
        .status,
    ).toBe(202);
  });

  it('does NOT refund once the job is durably enqueued (the token was really spent)', async () => {
    const questionId = `q_${newId()}`;
    await seedQuestion(questionId);
    const validated = await buildValidated(questionId, {
      rating: 'good',
      response_md: 'ans',
      auto_rate: true,
    });
    vi.stubEnv('AI_RATE_LIMIT_MAX', '1');
    const send = vi.fn().mockResolvedValue('job-1');
    expect(
      (await enqueueDurableJudge(validated, resolveSubjectProfile(), { boss: { send } })).status,
    ).toBe(202);
    // The single slot is now legitimately consumed — the next enqueue must be rejected.
    const blocked = await enqueueDurableJudge(validated, resolveSubjectProfile(), {
      boss: { send },
    });
    expect(blocked.status).toBe(429);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
