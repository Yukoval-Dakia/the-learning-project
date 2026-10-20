import type { Job } from 'pg-boss';
import type { Db } from '@/db/client';
import { type AgentRunDeps, runIngestionAgentSegment } from '../server/agent/run';

// YUK-1522 (R8) — pg-boss handler for the whole-package ingestion agent run.
// Each delivery runs ONE segment; segments suspend on open asks and resume on
// answer/timeout dispatch (see server/agent/run.ts). Durable claims survive
// queue retries; the existing ask sweeper recovers abandoned terminal writes.

export interface IngestionAgentRunJobData {
  readonly sessionId: string;
  readonly trigger?: 'start' | 'resume' | 'continue';
  readonly operationId?: string;
  readonly runRef?: string;
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
          ...(job.data.runRef != null ? { runRef: job.data.runRef } : {}),
          retryCount: job.retryCount ?? 0,
        },
        deps,
      );
      if (outcome.outcome === 'failed') {
        // A terminal write may still await sweep after a DB rollback. Logging
        // does not imply settlement committed and never requests a paid retry.
        console.error('[ingestion-agent] run segment failed', {
          session_id: sessionId,
          error: outcome.error,
        });
      }
    }
  };
}
