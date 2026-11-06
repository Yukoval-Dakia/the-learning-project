// Production entry for gap tickets. A server-written ticket event and the preparer job are
// one transaction, and the event id becomes the submission's causal anchor. Admission reads
// that anchor as supply lineage; it never treats `submit_question:*` as a pipeline publisher
// because the preparer may have read learner mistakes into the question.
import { newId } from '@/core/ids';
import type { Db } from '@/db/client';
import { writeEvent } from '@/kernel/events';
import { EvidenceDemandV1, type EvidenceDemandV1T } from '@/kernel/supply-contracts';
import { fromPgBossDrizzleTx, getStartedBoss } from '@/server/boss/client';
import { JOB_RETRY_DELAY_SECONDS, JOB_RETRY_LIMIT } from '@/server/boss/queue-config';

export const QUESTION_PREPARER_TICKET_ACTION = 'experimental:question_preparer_ticket';
/** Server-only actor; admission's lineage union admits exactly this writer. */
export const QUESTION_PREPARER_TICKET_ACTOR = 'practice:question_preparer';

/** Enqueue one durable gap ticket; the caller owns any request-level idempotency. */
export async function enqueueQuestionPreparerTicket(
  db: Db,
  ticket: EvidenceDemandV1T,
  now = new Date(),
): Promise<{ event_id: string; job_id: string | null }> {
  const parsed = EvidenceDemandV1.parse(ticket);
  const eventId = newId();
  const boss = await getStartedBoss();
  return db.transaction(async (tx) => {
    await writeEvent(tx, {
      id: eventId,
      actor_kind: 'system',
      actor_ref: QUESTION_PREPARER_TICKET_ACTOR,
      action: QUESTION_PREPARER_TICKET_ACTION,
      subject_kind: 'query',
      subject_id: parsed.demand_id,
      payload: {
        demand_id: parsed.demand_id,
        subject_id: parsed.subject_id,
        knowledge_ids: parsed.claim.knowledge_ids,
      },
      created_at: now,
    });
    const jobId = await boss.send(
      'question_preparer_run',
      { ticket: parsed, ticket_event_id: eventId },
      {
        db: fromPgBossDrizzleTx(tx),
        retryLimit: JOB_RETRY_LIMIT,
        retryDelay: JOB_RETRY_DELAY_SECONDS,
        retryBackoff: true,
      },
    );
    // No de-dupe key is set, so a null id means the send was not created; roll the ticket
    // event back instead of leaving lineage without a job.
    if (jobId === null) throw new Error('question_preparer_run was not enqueued');
    return { event_id: eventId, job_id: jobId };
  });
}
