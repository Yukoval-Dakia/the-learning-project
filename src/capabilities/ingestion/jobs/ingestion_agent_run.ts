import type { Job } from 'pg-boss';
import type { Db } from '@/db/client';
import { type AgentRunDeps, runIngestionAgentSegment } from '../server/agent/run';

// YUK-1522 (R8) — pg-boss handler for the whole-package ingestion agent run.
// Each delivery runs ONE segment; segments suspend on open asks and resume on
// answer/timeout dispatch (see server/agent/run.ts). includeMetadata supplies
// job.retryCount so the segment can write the honest terminal state when the
// queue's retries are exhausted.

export interface IngestionAgentRunJobData {
  readonly sessionId: string;
  readonly trigger?: 'start' | 'resume' | 'continue';
  readonly operationId?: string;
}

export function buildIngestionAgentRunHandler(db: Db, deps: AgentRunDeps = {}) {
  return async (jobs: Job<IngestionAgentRunJobData>[]) => {
    for (const job of jobs) {
      const sessionId = job.data?.sessionId;
      if (!sessionId) continue;
      const outcome = await runIngestionAgentSegment(
        db,
        {
          sessionId,
          trigger: job.data.trigger ?? 'start',
          ...(job.data.operationId != null ? { operationId: job.data.operationId } : {}),
          retryCount: job.retryCount ?? 0,
        },
        deps,
      );
      if (outcome.outcome === 'failed') {
        // Surface the failure on the pg-boss row too; the session is already
        // 'failed' and the contract error event is already emitted, so this is
        // visibility only — never a blind paid retry.
        console.error('[ingestion-agent] run segment failed', {
          session_id: sessionId,
          error: outcome.error,
        });
      }
    }
  };
}
