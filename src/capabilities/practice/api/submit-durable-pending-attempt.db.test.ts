// YUK-777 (A2) — record-unjudged-at-submit: the answer must be immutable domain
// evidence BEFORE judging, not a field inside a pg-boss payload.
//
// The defect this file pins (codex #Tu71c, confirmed real data loss): with
// JUDGE_DURABLE_ENABLED on, `enqueueDurableJudge` returned 202 after only
// `boss.send(...)`. Between that 202 and a successful backfill the learner's answer
// lived NOWHERE but the queue payload — so a run whose deliveries all failed into
// `judge_run_dlq`, or whose question was deleted before pickup, lost the answer
// permanently: not in the domain event log, and no pending attempt for a sweeper or a
// human to recover from.

import { newId } from '@/core/ids';
import { event, question } from '@/db/schema';
import { __resetRateLimitForTests } from '@/server/http/rate-limit';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { normalizeReviewSubmitActivityRef } from '../server/activity-ref';
import { CreateAttemptBodySchema } from './contracts';
import { enqueueDurableJudge } from './submit';

const ANSWER = 'the learner wrote this and it must never disappear';

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

describe('YUK-777 A2 — the answer survives a judge that never lands', () => {
  beforeEach(async () => {
    await resetDb();
    __resetRateLimitForTests();
    vi.unstubAllEnvs();
  });

  it('a 202-pending submit whose judging NEVER completes still leaves the answer in the domain event log', async () => {
    const questionId = `q_${newId()}`;
    await seedQuestion(questionId);
    const validated = await buildValidated(questionId, {
      rating: 'good',
      response_md: ANSWER,
      auto_rate: true,
    });

    // The dispatch succeeds: pg-boss accepts the job and the learner gets a 202.
    const sent: unknown[] = [];
    const res = await enqueueDurableJudge(validated, { subject: 'wenyan', version: 1 } as never, {
      boss: {
        send: async (_name, data) => {
          sent.push(data);
          return newId();
        },
      },
    });
    expect(res.status).toBe(202);
    expect(sent).toHaveLength(1);

    // …and then judging NEVER completes. Every delivery fails, the job lands in
    // `judge_run_dlq`, and no worker ever writes the backfill. The queue payload is
    // gone as far as the domain is concerned. What is left of this learner's answer?
    const rows = await testDb().select().from(event);
    const carriesTheAnswer = rows.filter((r) => JSON.stringify(r.payload).includes(ANSWER));

    expect(
      carriesTheAnswer.length,
      'the submitted answer must be recoverable from the permanent domain event log, not only from the pg-boss payload',
    ).toBeGreaterThan(0);
  });
});
