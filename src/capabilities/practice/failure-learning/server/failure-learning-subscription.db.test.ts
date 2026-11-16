import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { event, question } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { resetDb, testDb } from '../../../../../tests/helpers/db';
import { ATTRIBUTION_FOLLOWUP_QUEUE, failureLearningJobId } from '../jobs/failure-learning-jobs';
import {
  FAILURE_LEARNING_DISPATCH_ACTION,
  FAILURE_LEARNING_DISPATCH_INTENT_ACTION,
  drainFailureLearningDispatch,
  writeFailureLearningDispatchIntent,
} from './failure-learning-dispatch';
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

async function dispatchRows(action: string) {
  return testDb().select({ id: event.id }).from(event).where(eq(event.action, action));
}

describe('Failure Learning attempt subscription', () => {
  beforeEach(async () => {
    await resetDb();
  });

  // @invariant concurrency: the subscription commits only the
  // intent; the engine sees one stable delivery and the ack records acceptance
  // @fails-if a replay mints a second send or the ack precedes acceptance —
  // the attribution stage would double-pay or lose its crash window
  it('commits the intent, delivers under the stable job id, and acks once', async () => {
    await seedFailureAttempt();
    const expectedJobId = failureLearningJobId(ATTRIBUTION_FOLLOWUP_QUEUE, ATTEMPT_ID);
    const bossSend = vi.fn().mockResolvedValue(expectedJobId);

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

    expect(bossSend).toHaveBeenCalledTimes(1);
    expect(bossSend).toHaveBeenCalledWith(
      ATTRIBUTION_FOLLOWUP_QUEUE,
      { attempt_event_id: ATTEMPT_ID },
      { id: expectedJobId },
    );
    expect(await dispatchRows(FAILURE_LEARNING_DISPATCH_INTENT_ACTION)).toHaveLength(1);
    expect(await dispatchRows(FAILURE_LEARNING_DISPATCH_ACTION)).toHaveLength(1);
  });

  // @invariant concurrency: a committed intent whose engine acceptance never
  // landed is re-driven by the single drain owner under the same stable id
  // @fails-if the drain loses a bound-but-unacked intent or re-sends after the
  // ack — the crash window between business commit and send would lose work
  it('re-drives a committed intent whose acceptance event never landed', async () => {
    await seedFailureAttempt();
    const db = testDb();
    const expectedJobId = await writeFailureLearningDispatchIntent(db, ATTEMPT_ID);
    const bossSend = vi.fn().mockResolvedValue(expectedJobId);

    const first = await drainFailureLearningDispatch(db, bossSend);
    expect(first).toEqual({ scanned: 1, dispatched: 1, failed: 0 });
    expect(bossSend).toHaveBeenCalledWith(
      ATTRIBUTION_FOLLOWUP_QUEUE,
      { attempt_event_id: ATTEMPT_ID },
      { id: expectedJobId },
    );

    const second = await drainFailureLearningDispatch(db, bossSend);
    expect(second.dispatched).toBe(0);
    expect(bossSend).toHaveBeenCalledTimes(1);
  });
});
