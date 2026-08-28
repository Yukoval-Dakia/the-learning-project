import type { Job } from 'pg-boss';
import type { Db } from '@/db/client';
import {
  COPILOT_CONTINUATION_QUEUE,
  attachContinuationJobId,
  claimSubagentRun,
  heartbeatSubagentRun,
  settleSubagentRun,
} from '../server/subagent-mailbox';
import { enqueueCopilotMailboxJob, runCopilotResearcher } from './copilot_run';

export function buildCopilotSubagentRunHandler(db: Db) {
  return async (jobs: Job<{ run_id: string }>[]): Promise<void> => {
    for (const job of jobs) {
      const claimed = await claimSubagentRun(db, job.data.run_id);
      if (!claimed) continue;
      if ('lost' in claimed) {
        const continuationId = `copilot_continuation_${job.data.run_id}`;
        const continuationJobId = await enqueueCopilotMailboxJob(
          COPILOT_CONTINUATION_QUEUE,
          continuationId,
          { continuation_id: continuationId },
        );
        if (continuationJobId) {
          await attachContinuationJobId(db, continuationId, continuationJobId);
        }
        continue;
      }
      const { record, claimToken } = claimed;
      const abortController = new AbortController();
      let hardDeadlineExceeded = false;
      const poll = setInterval(() => {
        void (async () => {
          const heartbeat = await heartbeatSubagentRun(db, record.id, claimToken);
          if (heartbeat === 'deadline_reached') {
            hardDeadlineExceeded = true;
            abortController.abort(new Error('subagent hard deadline reached'));
            return;
          }
          const current = await import('../server/subagent-mailbox').then((module) =>
            module.getSubagentRun(db, record.id),
          );
          if (current.cancelRequestedBy) abortController.abort(new Error('subagent cancelled'));
        })().catch(() => undefined);
      }, 500);
      poll.unref?.();
      let outcome:
        | { status: 'succeeded'; result: string }
        | { status: 'failed' | 'cancelled' | 'lost'; error: { code: string; message: string } };
      try {
        const result = await runCopilotResearcher(db, record, abortController);
        outcome = hardDeadlineExceeded
          ? {
              status: 'lost',
              error: { code: 'hard_deadline_exceeded', message: 'Subagent hard deadline elapsed' },
            }
          : abortController.signal.aborted
            ? {
                status: 'cancelled',
                error: { code: 'cancelled', message: 'Subagent cancellation was confirmed' },
              }
            : { status: 'succeeded', result: result.text };
      } catch (error) {
        outcome = hardDeadlineExceeded
          ? {
              status: 'lost',
              error: { code: 'hard_deadline_exceeded', message: 'Subagent hard deadline elapsed' },
            }
          : abortController.signal.aborted
            ? {
                status: 'cancelled',
                error: { code: 'cancelled', message: 'Subagent cancellation was confirmed' },
              }
            : {
                status: 'failed',
                error: {
                  code: 'research_failed',
                  message: error instanceof Error ? error.message : String(error),
                },
              };
      } finally {
        clearInterval(poll);
      }
      await settleSubagentRun(db, record.id, claimToken, outcome);
      const continuationId = `copilot_continuation_${record.id}`;
      const continuationJobId = await enqueueCopilotMailboxJob(
        COPILOT_CONTINUATION_QUEUE,
        continuationId,
        { continuation_id: continuationId },
      );
      if (continuationJobId) await attachContinuationJobId(db, continuationId, continuationJobId);
    }
  };
}
