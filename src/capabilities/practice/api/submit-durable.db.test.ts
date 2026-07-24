// YUK-594 (durable judge main path, W2) — submit-face async-main divert tests.
//
// Covers: flag-OFF byte-identical anchor (no 202, normal review_event shape); the
// divert predicate (resolveDurableDivert mirrors judgeSubmit's server-invoke gate);
// and enqueueDurableJudge's 202-pending contract + queued job_event + frozen payload.

import { newId } from '@/core/ids';
import { event, job_events, question } from '@/db/schema';
import { computeReplay } from '@/server/events/sse_replay';
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
});
