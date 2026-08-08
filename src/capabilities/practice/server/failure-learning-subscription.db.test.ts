import { event, question } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from '../../../../tests/helpers/db';
import { ATTRIBUTION_FOLLOWUP_QUEUE, failureLearningJobId } from '../jobs/failure-learning-jobs';
import { handleFailureLearningAttemptDelivery } from './failure-learning-subscription';

const ATTEMPT_ID = 'failure_learning_subscription_attempt';

function delivery(sourceEventId = ATTEMPT_ID) {
  return {
    subscriberId: 'practice.failure-learning-attempt',
    subscriberVersion: 1,
    deliverySeq: '1',
    sourceEventId,
  };
}

async function seedQuestion(): Promise<void> {
  const now = new Date('2026-08-08T08:00:00.000Z');
  await testDb()
    .insert(question)
    .values({
      id: 'q_failure_learning_subscription',
      kind: 'short_answer',
      prompt_md: '解释链式法则，并计算 y=sin(x²) 的导数。',
      reference_md: '外层导数乘以内层导数：2x cos(x²)。',
      source: 'manual',
      knowledge_ids: ['kc_chain_rule'],
      created_at: now,
      updated_at: now,
    });
}

async function seedFailureAttempt(payload: Record<string, unknown> = {}): Promise<void> {
  await seedQuestion();
  await writeEvent(testDb(), {
    id: ATTEMPT_ID,
    actor_kind: 'user',
    actor_ref: 'self',
    action: 'attempt',
    subject_kind: 'question',
    subject_id: 'q_failure_learning_subscription',
    outcome: 'failure',
    payload: {
      answer_md: 'cos(x²)+2x',
      answer_image_refs: [],
      referenced_knowledge_ids: ['kc_chain_rule'],
      ...payload,
    },
    created_at: new Date('2026-08-08T08:01:00.000Z'),
  });
}

describe('Failure Learning attempt subscription', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('transactionally enqueues the stable attribution job and accepts replay', async () => {
    await seedFailureAttempt();
    const expectedJobId = failureLearningJobId(ATTRIBUTION_FOLLOWUP_QUEUE, ATTEMPT_ID);
    const bossSend = vi.fn().mockResolvedValueOnce(expectedJobId).mockResolvedValueOnce(null);

    await expect(
      handleFailureLearningAttemptDelivery(testDb(), delivery(), { bossSend }),
    ).resolves.toEqual({
      status: 'succeeded',
      detail: { attempt_event_id: ATTEMPT_ID, attribution_job_id: expectedJobId },
    });
    await expect(
      handleFailureLearningAttemptDelivery(testDb(), delivery(), { bossSend }),
    ).resolves.toEqual({
      status: 'succeeded',
      detail: { attempt_event_id: ATTEMPT_ID, attribution_job_id: expectedJobId },
    });

    expect(bossSend).toHaveBeenCalledTimes(2);
    expect(bossSend).toHaveBeenNthCalledWith(
      1,
      ATTRIBUTION_FOLLOWUP_QUEUE,
      { attempt_event_id: ATTEMPT_ID },
      { id: expectedJobId, db: expect.any(Object) },
    );
  });

  it('skips unsupported paper attempts before enqueue', async () => {
    await seedFailureAttempt({ unsupported_judge: true });
    const bossSend = vi.fn();

    await expect(
      handleFailureLearningAttemptDelivery(testDb(), delivery(), { bossSend }),
    ).resolves.toEqual({ status: 'skipped', reason: 'unsupported judge' });
    expect(bossSend).not.toHaveBeenCalled();
  });

  it('skips an attempt with an active authoritative user cause', async () => {
    await seedFailureAttempt();
    await writeEvent(testDb(), {
      id: 'failure_learning_user_cause',
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'experimental:user_cause',
      subject_kind: 'event',
      subject_id: ATTEMPT_ID,
      outcome: 'success',
      payload: { primary_category: 'method', user_notes: '我忘了链式法则要相乘。' },
      caused_by_event_id: ATTEMPT_ID,
      created_at: new Date('2026-08-08T08:02:00.000Z'),
    });
    const bossSend = vi.fn();

    await expect(
      handleFailureLearningAttemptDelivery(testDb(), delivery(), { bossSend }),
    ).resolves.toEqual({
      status: 'skipped',
      reason: 'active user cause is authoritative',
    });
    expect(bossSend).not.toHaveBeenCalled();
  });

  it('skips a retracted attempt because it is no longer effective active', async () => {
    await seedFailureAttempt();
    await writeEvent(testDb(), {
      id: 'failure_learning_attempt_retraction',
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'correct',
      subject_kind: 'event',
      subject_id: ATTEMPT_ID,
      outcome: 'success',
      payload: {
        correction_kind: 'retract',
        reason_md: '这次作答记录无效。',
        affected_refs: [{ kind: 'question', id: 'q_failure_learning_subscription' }],
      },
      created_at: new Date('2026-08-08T08:03:00.000Z'),
    });
    const bossSend = vi.fn();

    await expect(
      handleFailureLearningAttemptDelivery(testDb(), delivery(), { bossSend }),
    ).resolves.toEqual({
      status: 'skipped',
      reason: 'attempt is not effective active',
    });
    expect(bossSend).not.toHaveBeenCalled();
  });

  it('skips committed events outside the attempt-question-failure lane', async () => {
    await seedQuestion();
    await writeEvent(testDb(), {
      id: 'successful_attempt',
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'attempt',
      subject_kind: 'question',
      subject_id: 'q_failure_learning_subscription',
      outcome: 'success',
      payload: {
        answer_md: '2x cos(x²)',
        answer_image_refs: [],
        referenced_knowledge_ids: ['kc_chain_rule'],
      },
      created_at: new Date('2026-08-08T08:01:00.000Z'),
    });
    const bossSend = vi.fn();

    await expect(
      handleFailureLearningAttemptDelivery(testDb(), delivery('successful_attempt'), { bossSend }),
    ).resolves.toEqual({
      status: 'skipped',
      reason: 'not an attempt question failure',
    });
    expect(bossSend).not.toHaveBeenCalled();
  });

  it('rethrows enqueue failures so the subscription runtime retries', async () => {
    await seedFailureAttempt();
    const bossSend = vi.fn(async () => {
      throw new Error('pg-boss unavailable');
    });

    await expect(
      handleFailureLearningAttemptDelivery(testDb(), delivery(), { bossSend }),
    ).rejects.toThrow('pg-boss unavailable');

    const [attempt] = await testDb().select().from(event).where(eq(event.id, ATTEMPT_ID));
    expect(attempt?.action).toBe('attempt');
  });
});
