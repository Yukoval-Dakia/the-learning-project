// YUK-594 (W2) — createAttemptResource must pass a 202-pending divert response
// THROUGH untouched, instead of feeding it to canonicalResourceResponse (whose
// Location derives from `review_event.id`, absent on the pending body → contract
// break). This file forces the durable divert to fire in the test env by mocking
// shouldEnqueueBackgroundJobs → true and getStartedBoss → a fake, then asserts the
// resource wrapper returns the 202 verbatim (no crash, Location preserved).

import { newId } from '@/core/ids';
import {
  INTERVENTION_CONTRACT_VERSION,
  INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE,
} from '@/core/schema/intervention';
import { event, material_fsrs_state, question } from '@/db/schema';
import { __resetRateLimitForTests } from '@/server/http/rate-limit';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';

vi.mock('@/server/runtime-env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/runtime-env')>();
  return { ...actual, shouldEnqueueBackgroundJobs: () => true };
});

const bossSend = vi.fn().mockResolvedValue('job-1');
vi.mock('@/server/boss/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/server/boss/client')>();
  return { ...actual, getStartedBoss: async () => ({ send: bossSend }) };
});

import { createAttempt, createAttemptResource } from './submit';

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

describe('createAttemptResource — durable divert 202 pass-through (W2)', () => {
  beforeEach(async () => {
    await resetDb();
    __resetRateLimitForTests();
    bossSend.mockClear();
    vi.stubEnv('JUDGE_DURABLE_ENABLED', '1');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('passes the 202-pending response through the resource wrapper untouched (no review_event crash)', async () => {
    const questionId = `q_${newId()}`;
    await seedQuestion(questionId);
    const res = await createAttemptResource(
      new Request('http://localhost/api/attempts', {
        method: 'POST',
        body: JSON.stringify({
          question_id: questionId,
          rating: 'good',
          response_md: 'my answer',
          auto_rate: true,
        }),
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(res.status).toBe(202);
    const body = (await res.json()) as { verdict?: string; run_id?: string };
    expect(body.verdict).toBe('pending');
    expect(res.headers.get('Location')).toBe(`/api/jobs/judge_run/${body.run_id}/events`);
    // #8 — the pass-through is keyed on this EXPLICIT discriminant, not a bare 202, so an
    // unrelated future 202 from this route still goes through the resource wrapper.
    expect(res.headers.get('x-durable-divert')).toBe('judge');
    expect(bossSend).toHaveBeenCalledTimes(1);
  });

  it('flag-ON but MANUAL rating (no server judge) does NOT divert — FSRS advances immediately, not 202', async () => {
    const questionId = `q_${newId()}`;
    await seedQuestion(questionId);
    // auto_rate omitted → no server-side judge call → nothing to move off the request
    // window → the manual rating writes the review event + FSRS synchronously.
    const res = await createAttemptResource(
      new Request('http://localhost/api/attempts', {
        method: 'POST',
        body: JSON.stringify({ question_id: questionId, rating: 'good' }),
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(res.status).not.toBe(202);
    expect(bossSend).not.toHaveBeenCalled();
    // The attempt review event + FSRS state landed immediately (no deferral).
    const reviews = await testDb().select().from(event).where(eq(event.action, 'review'));
    expect(reviews).toHaveLength(1);
    const fsrs = await testDb()
      .select()
      .from(material_fsrs_state)
      .where(eq(material_fsrs_state.subject_id, 'k1'));
    expect(fsrs.length).toBeGreaterThan(0);
  });

  it('releases a diagnostic claim when durable admission returns an error response', async () => {
    vi.stubEnv('AI_RATE_LIMIT_MAX', '1');
    const firstQuestionId = `q_${newId()}`;
    await seedQuestion(firstQuestionId);
    const accepted = await createAttempt(
      new Request('http://localhost/api/attempts', {
        method: 'POST',
        body: JSON.stringify({
          question_id: firstQuestionId,
          rating: 'good',
          response_md: 'first answer',
          auto_rate: true,
        }),
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(accepted.status).toBe(202);

    const diagnosticId = `q_${newId()}`;
    const now = new Date();
    await testDb()
      .insert(question)
      .values({
        id: diagnosticId,
        prompt_md: 'Diagnostic prompt',
        kind: 'short_answer',
        reference_md: 'Diagnostic answer',
        judge_kind_override: 'multimodal_direct',
        knowledge_ids: [],
        difficulty: 3,
        source: INTERVENTION_DIAGNOSTIC_QUESTION_SOURCE,
        draft_status: 'active',
        variant_depth: 0,
        version: 0,
        metadata: {
          intervention_diagnostic: {
            schema_version: INTERVENTION_CONTRACT_VERSION,
            intervention_id: 'int_durable_admission',
            intervention_version: 1,
            diagnostic_kind: 'immediate',
            knowledge_id: 'kc_durable',
            due_at: '2026-07-01T00:00:00.000Z',
          },
        },
        created_at: now,
        updated_at: now,
      });

    const rejected = await createAttempt(
      new Request('http://localhost/api/attempts', {
        method: 'POST',
        body: JSON.stringify({
          question_id: diagnosticId,
          rating: 'good',
          response_md: 'diagnostic answer',
          auto_rate: true,
        }),
        headers: { 'content-type': 'application/json' },
      }),
    );

    expect(rejected.status).toBe(429);
    const [row] = await testDb()
      .select({ draftStatus: question.draft_status })
      .from(question)
      .where(eq(question.id, diagnosticId));
    expect(row.draftStatus).toBe('active');
  });
});
