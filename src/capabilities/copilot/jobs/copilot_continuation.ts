import { and, eq } from 'drizzle-orm';
import type { Job } from 'pg-boss';
import type { Db } from '@/db/client';
import { copilot_continuation } from '@/db/schema';
import { writeCopilotReply } from '../server/chat';
import { claimCopilotContinuation, settleCopilotContinuation } from '../server/subagent-mailbox';
import { runCopilotContinuationTask } from './copilot_run';

export function buildCopilotContinuationHandler(db: Db) {
  return async (jobs: Job<{ continuation_id: string }>[]): Promise<void> => {
    for (const job of jobs) {
      const claimed = await claimCopilotContinuation(db, job.data.continuation_id);
      if (!claimed || 'waiting' in claimed || 'lost' in claimed) continue;
      const { record, child, claimToken } = claimed;
      try {
        const result = await runCopilotContinuationTask(db, record, child);
        await db.transaction(async (tx) => {
          const [owned] = await tx
            .select()
            .from(copilot_continuation)
            .where(eq(copilot_continuation.id, record.id))
            .for('update');
          if (
            owned?.status !== 'running' ||
            owned.claim_token !== claimToken ||
            owned.reply_event_id
          ) {
            return;
          }
          const reply = await writeCopilotReply(tx, {
            sessionId: record.sessionId,
            userAskEventId: record.resultEventId,
            replyText: result.text,
            actorRef: 'agent:copilot',
            taskRunId: result.taskRunId,
            outcome: 'success',
            now: new Date(),
          });
          await tx
            .update(copilot_continuation)
            .set({
              status: 'succeeded',
              reply_event_id: reply.replyEventId,
              settled_at: new Date(),
              lease_expires_at: null,
              updated_at: new Date(),
            })
            .where(
              and(
                eq(copilot_continuation.id, record.id),
                eq(copilot_continuation.claim_token, claimToken),
                eq(copilot_continuation.status, 'running'),
              ),
            );
        });
      } catch (error) {
        await settleCopilotContinuation(db, {
          continuationId: record.id,
          claimToken,
          status: 'failed',
          error: {
            code: 'continuation_failed',
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }
  };
}
