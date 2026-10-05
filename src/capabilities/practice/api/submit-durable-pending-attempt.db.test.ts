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

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newId } from '@/core/ids';
import { assessment_submission, event, knowledge, question } from '@/db/schema';
import { __resetRateLimitForTests } from '@/server/http/rate-limit';
import { issueSoloFixture } from '../../../../tests/fixtures/assessment-solo';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { dispatchNativeAttempt } from '../server/assessment/durable-attempt';

const ANSWER = 'the learner wrote this and it must never disappear';

async function seedQuestion(id: string) {
  const now = new Date();
  await testDb().insert(knowledge).values({
    id: 'k1',
    name: 'K1',
    domain: 'math',
    parent_id: null,
    created_at: now,
    updated_at: now,
  });
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

describe('YUK-777 A2 — the answer survives a judge that never lands', () => {
  beforeEach(async () => {
    await resetDb();
    __resetRateLimitForTests();
    vi.unstubAllEnvs();
  });

  it('a 202-pending submit whose judging NEVER completes still leaves the answer in the domain event log', async () => {
    const questionId = `q_${newId()}`;
    await seedQuestion(questionId);
    const issued = await issueSoloFixture(testDb(), questionId, true);
    const assessment = issued.assessment(ANSWER);
    const sent: unknown[] = [];
    const runId = await dispatchNativeAttempt(
      testDb(),
      questionId,
      assessment,
      { enabled: true, capture: { response_md: ANSWER } },
      {
        boss: {
          send: async (_name, data) => {
            sent.push(data);
            return newId();
          },
        },
      },
    );
    expect(runId).toBeTruthy();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ caller: 'native_assessment', run_id: runId });

    // …and then judging NEVER completes. Every delivery fails, the job lands in
    // `judge_run_dlq`, and no worker ever writes the backfill. The queue payload is
    // gone as far as the domain is concerned. What is left of this learner's answer?
    const rows = await testDb().select().from(event);
    const carriesTheAnswer = rows.filter((r) => JSON.stringify(r.payload).includes(ANSWER));
    const original = rows.find((row) => row.action === 'experimental:assessment_submission');
    expect(original?.payload).toMatchObject({
      response_set: assessment.response_set,
      learning_scope: {
        questions: [{ id: questionId, knowledge_ids: ['k1'] }],
        ability_global_by_knowledge_id: { k1: 'math' },
      },
    });
    expect(await testDb().select().from(assessment_submission)).toMatchObject([
      { response_set: assessment.response_set, issuance_id: assessment.issuance_id },
    ]);

    expect(
      carriesTheAnswer.length,
      'the submitted answer must be recoverable from the permanent domain event log, not only from the pg-boss payload',
    ).toBeGreaterThan(0);
  });
});
