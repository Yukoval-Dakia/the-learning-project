import type { Job } from 'pg-boss';
import type { Db } from '@/db/client';
import {
  COPILOT_CONTINUATION_QUEUE,
  SUBAGENT_RUN_QUEUE,
  attachContinuationJobId,
  attachSubagentJobId,
  recoverSubagentMailbox,
} from '../server/subagent-mailbox';
import { enqueueCopilotMailboxJob } from './copilot_run';

export function buildCopilotSubagentReconcileHandler(db: Db) {
  return async (_jobs: Job<Record<string, never>>[]): Promise<void> => {
    const recovered = await recoverSubagentMailbox(db);
    for (const runId of recovered.queuedRunIds) {
      const jobId = await enqueueCopilotMailboxJob(SUBAGENT_RUN_QUEUE, runId, { run_id: runId });
      if (jobId) await attachSubagentJobId(db, runId, jobId);
    }
    for (const continuationId of recovered.pendingContinuationIds) {
      const jobId = await enqueueCopilotMailboxJob(COPILOT_CONTINUATION_QUEUE, continuationId, {
        continuation_id: continuationId,
      });
      if (jobId) await attachContinuationJobId(db, continuationId, jobId);
    }
  };
}
