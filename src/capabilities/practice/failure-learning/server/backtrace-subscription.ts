import { eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { fromPgBossDrizzleTx } from '@/db/pg-boss-drizzle';
import { event } from '@/db/schema';
import type { EventSubscriptionHandlerFactory } from '@/kernel/manifest';
import { assessmentAttemptEventId } from '@/kernel/records/assessment-attempt-identity';
import { checkRateLimit } from '@/kernel/request-rate-limit';
import { getStartedBoss } from '@/server/boss/client';
import { loadBacktraceInput } from './backtrace-input';
import { backtracePool } from './backtrace-pool';
import { currentInsight } from './backtrace-store';
import { failureLearningJobId } from './failure-learning-identity';

export const buildBacktraceSubscriber: EventSubscriptionHandlerFactory =
  (db: Db) => async (delivery) => {
    const boss = await getStartedBoss();
    return db.transaction(async (tx) => {
      const [source] = await tx.select().from(event).where(eq(event.id, delivery.sourceEventId));
      if (!source) return { status: 'skipped', reason: 'source unavailable' };
      let id = source.id;
      if (source.action === 'experimental:assessment_feedback_released') {
        if (source.subject_kind !== 'event') return { status: 'skipped', reason: 'no attempt' };
        id = source.subject_id;
      } else if (
        source.action === 'experimental:assessment_activation' &&
        typeof source.payload.submission_id === 'string'
      )
        id = assessmentAttemptEventId(source.payload.submission_id);
      else if (source.action === 'correct') {
        const [target] = await tx.select().from(event).where(eq(event.id, source.subject_id));
        id = target?.subject_kind === 'event' ? target.subject_id : source.subject_id;
      } else if (source.subject_kind === 'event') id = source.subject_id;
      const basis = await loadBacktraceInput(tx, id);
      if (!basis) return { status: 'skipped', reason: 'not an authorized graded attempt' };
      // Paid-model work rides this job — charge the same shared AI window the
      // judge funnel charges before enqueueing, so a burst of fresh attempt
      // ids cannot mint unbounded provider sends.
      checkRateLimit();
      await boss.send(
        'attempt_backtrace',
        { attempt_event_id: id },
        {
          id: failureLearningJobId('attempt_backtrace', `${id}:${basis.digest}`),
          db: fromPgBossDrizzleTx(tx),
        },
      );
      return { status: 'succeeded', detail: { attempt_event_id: id } };
    });
  };

export async function requestBacktraceRepair(db: Db, attemptEventId: string) {
  const boss = await getStartedBoss();
  return db.transaction(async (tx) => {
    const basis = await loadBacktraceInput(tx, attemptEventId);
    if (!basis?.visible) return;
    // Judgement work is keyed on the candidate-pool generation, not only the
    // attempt's input digest: an earlier attempt gaining an insight changes
    // the pool while basis.digest stays put — a completed job id must not
    // dedupe the fresh repair that the read model still reports as judging.
    const anchor = await currentInsight(tx, attemptEventId);
    const generation = anchor ? (await backtracePool(tx, anchor)).digest : basis.digest;
    checkRateLimit();
    await boss.send(
      'attempt_backtrace',
      { attempt_event_id: attemptEventId },
      {
        id: failureLearningJobId('attempt_backtrace', `${attemptEventId}:${generation}`),
        db: fromPgBossDrizzleTx(tx),
      },
    );
  });
}
