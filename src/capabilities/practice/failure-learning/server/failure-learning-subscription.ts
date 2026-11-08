import { eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { event } from '@/db/schema';
import type {
  EventSubscriptionDelivery,
  EventSubscriptionHandlerFactory,
  EventSubscriptionOutcome,
} from '@/kernel/manifest';
import { assessmentAttemptEventId } from '@/kernel/records/assessment-attempt-identity';
import { getStartedBoss } from '@/server/boss/client';
import type { FailureLearningBossSend } from '../jobs/failure-learning-jobs';
import { requestFailureLearning } from './failure-learning';
import {
  drainFailureLearningDispatch,
  writeFailureLearningDispatchIntent,
} from './failure-learning-dispatch';

interface FailureLearningSubscriptionDeps {
  bossSend?: FailureLearningBossSend;
}

/**
 * Turns one committed effective-active question failure into durable work.
 * The business transaction records only the intent event; the engine send runs
 * after commit under the stable stage job id, and the dispatch cron re-drives
 * the same intent if this process dies before its acceptance event lands.
 */
export async function handleFailureLearningAttemptDelivery(
  db: Db,
  delivery: EventSubscriptionDelivery,
  deps: FailureLearningSubscriptionDeps = {},
): Promise<EventSubscriptionOutcome> {
  const outcome = await db.transaction(async (tx) => {
    const [source] = await tx.select().from(event).where(eq(event.id, delivery.sourceEventId));
    const attemptEventId =
      source?.action === 'experimental:assessment_activation' &&
      typeof source.payload.submission_id === 'string'
        ? assessmentAttemptEventId(source.payload.submission_id)
        : source?.action === 'experimental:assessment_feedback_released' &&
            source.subject_kind === 'event' &&
            source.payload.attempt_event_id === source.subject_id
          ? source.subject_id
          : delivery.sourceEventId;
    const result = await requestFailureLearning(
      {
        db: tx,
        recordAttributionIntent: (attemptEventId) =>
          writeFailureLearningDispatchIntent(tx, attemptEventId),
      },
      { attemptEventId },
    );
    if (result.status === 'ignored') {
      const reasons = {
        attempt_not_found: 'source event not found',
        not_failure_attempt: 'not an attempt question failure',
        attempt_not_active: 'attempt is not effective active',
        unsupported_judge: 'unsupported judge',
        user_cause_present: 'active user cause is authoritative',
        verdict_overturned: 'verdict overturned to correct',
      } satisfies Record<typeof result.reason, string>;
      return { status: 'skipped' as const, reason: reasons[result.reason] };
    }
    return {
      status: 'succeeded' as const,
      detail: {
        attempt_event_id: attemptEventId,
        attribution_job_id: result.attributionJobId,
      },
    };
  });

  // The durable intent is committed; deliver now. A throw here retries the
  // delivery, whose replay is idempotent on the intent row and the stable job
  // id; a lost process leaves the dispatch cron to re-drive the same intent.
  if (outcome.status === 'succeeded') {
    let send = deps.bossSend;
    if (!send) {
      const boss = await getStartedBoss();
      send = boss.send.bind(boss) as FailureLearningBossSend;
    }
    await drainFailureLearningDispatch(db, send, {
      attemptEventId: outcome.detail.attempt_event_id as string,
    });
  }
  return outcome;
}

export const buildFailureLearningAttemptSubscriber: EventSubscriptionHandlerFactory = (db: Db) => {
  return (delivery) => handleFailureLearningAttemptDelivery(db, delivery);
};
