import { eq } from 'drizzle-orm';
import type { Db } from '@/db/client';
import { fromPgBossDrizzleTx } from '@/db/pg-boss-drizzle';
import { event } from '@/db/schema';
import type { EventSubscriptionHandlerFactory } from '@/kernel/manifest';
import { assessmentAttemptEventId } from '@/kernel/records/assessment-attempt-identity';
import { getStartedBoss } from '@/server/boss/client';
import { loadBacktraceInput } from './backtrace-input';
import { failureLearningJobId } from './failure-learning-identity';

export const buildBacktraceSubscriber: EventSubscriptionHandlerFactory =
  (db: Db) => async (delivery) => {
    const boss = await getStartedBoss();
    return db.transaction(async (tx) => {
      const [source] = await tx.select().from(event).where(eq(event.id, delivery.sourceEventId));
      if (!source) return { status: 'skipped', reason: 'source unavailable' };
      let id = source.id;
      if (
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
    await boss.send(
      'attempt_backtrace',
      { attempt_event_id: attemptEventId },
      {
        id: failureLearningJobId('attempt_backtrace', `${attemptEventId}:${basis.digest}`),
        db: fromPgBossDrizzleTx(tx),
      },
    );
  });
}
