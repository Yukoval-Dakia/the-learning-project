import type { Db } from '@/db/client';
import type {
  EventSubscriptionDelivery,
  EventSubscriptionHandlerFactory,
  EventSubscriptionOutcome,
} from '@/kernel/manifest';
import {
  type FailureLearningBossSend,
  enqueueAttributionFollowup,
} from '../jobs/failure-learning-jobs';
import { requestFailureLearning } from './failure-learning';
import { getPracticeBoss } from './queue-runtime';

interface FailureLearningSubscriptionDeps {
  bossSend?: FailureLearningBossSend;
}

/**
 * Turns one committed, effective-active question failure into durable work.
 * Eligibility reads and the pg-boss insert share the same database transaction;
 * the stable job UUID makes a delivery replay a successful no-op.
 */
export async function handleFailureLearningAttemptDelivery(
  db: Db,
  delivery: EventSubscriptionDelivery,
  deps: FailureLearningSubscriptionDeps = {},
): Promise<EventSubscriptionOutcome> {
  let send = deps.bossSend;
  if (!send) {
    const boss = await getPracticeBoss();
    send = boss.send.bind(boss) as FailureLearningBossSend;
  }

  return db.transaction(async (tx) => {
    const result = await requestFailureLearning(
      {
        db: tx,
        enqueueAttribution: (attemptEventId) =>
          enqueueAttributionFollowup(send, attemptEventId, tx),
      },
      { attemptEventId: delivery.sourceEventId },
    );
    if (result.status === 'ignored') {
      const reasons = {
        attempt_not_found: 'source event not found',
        not_failure_attempt: 'not an attempt question failure',
        attempt_not_active: 'attempt is not effective active',
        unsupported_judge: 'unsupported judge',
        user_cause_present: 'active user cause is authoritative',
      } satisfies Record<typeof result.reason, string>;
      return { status: 'skipped', reason: reasons[result.reason] };
    }
    return {
      status: 'succeeded',
      detail: {
        attempt_event_id: delivery.sourceEventId,
        attribution_job_id: result.attributionJobId,
      },
    };
  });
}

export const buildFailureLearningAttemptSubscriber: EventSubscriptionHandlerFactory = (db: Db) => {
  return (delivery) => handleFailureLearningAttemptDelivery(db, delivery);
};
