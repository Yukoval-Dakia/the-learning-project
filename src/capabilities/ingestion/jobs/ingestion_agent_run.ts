import type { Job } from 'pg-boss';
import type { Db } from '@/db/client';
import { type AgentRunDeps, runIngestionAgentSegment } from '../server/agent/run';

// pg-boss handler for the whole-package agent run. Each delivery runs one segment;
// open asks suspend it until an answer or timeout re-dispatches. Durable claims
// survive retries, and the ask sweeper recovers abandoned terminal writes.

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
