// YUK-777 (A3) — domain-state-scan reconcile sweeper.
//
// The behaviour under test is "an answer that was recorded but never judged gets another
// dispatch, and nothing else does". Each case below pins one of the four ways the sweeper can
// decide, because getting any of them wrong is expensive in a different direction: a missed
// stall strands a learner's answer, and a spurious re-enqueue buys a duplicate paid judge.

import type { JobWithMetadata } from 'pg-boss';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newId } from '@/core/ids';
import { job_events, question } from '@/db/schema';
import { __resetRateLimitForTests } from '@/server/http/rate-limit';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { judgeRecoveryJobId, recordJudgePendingAttempt } from '../server/judge-run-dispatch';
import { JUDGE_RUN_EVENTS, JUDGE_RUN_TABLE } from '../server/judge-run-status';
import { RECONCILE_STALL_MS, reconcileStalledJudgeAttempts } from './judge_pending_reconcile';

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

  it('counts duplicate markers for one deterministic delivery as one recovery attempt', async () => {
    const { runId } = await seedPendingAttempt({ agoMs: RECONCILE_STALL_MS + HOUR });
    const deliveryId = judgeRecoveryJobId(runId, 1);
    await testDb()
      .insert(job_events)
      .values([
        {
          business_table: JUDGE_RUN_TABLE,
          business_id: runId,
          event_type: JUDGE_RUN_EVENTS.REQUEUED,
          payload: { attempt: 1, delivery_id: deliveryId },
        },
        {
          business_table: JUDGE_RUN_TABLE,
          business_id: runId,
          event_type: JUDGE_RUN_EVENTS.REQUEUED,
          payload: { attempt: 1, delivery_id: deliveryId },
        },
      ]);
    const boss = deadBoss();

    expect(await reconcileStalledJudgeAttempts(testDb(), { deps: { boss } })).toMatchObject({
      reenqueued: 1,
      skippedExhausted: 0,
    });
    expect(boss.send.mock.calls[0][2]).toEqual({ id: judgeRecoveryJobId(runId, 2) });
  });
});
