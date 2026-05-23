// YUK-48 — nightly KnowledgeReviewTask maintenance producer.
//
// Existing node/edge nightly jobs are cheap structured-output producers. This
// queue runs the broader tool-calling KnowledgeReviewTask after them, so it can
// propose tree maintenance mutations while still writing only inbox proposals.

import type { Db } from '@/db/client';
import { streamReviewTask } from '@/server/knowledge/review';
import { listProposalInboxRows } from '@/server/proposals/inbox';
import type { Job } from 'pg-boss';

export interface KnowledgeMaintenanceNightlyResult {
  processed: number;
  proposals_created: number;
  pending_after: number;
}

export type StreamReviewTaskFn = (ctx: { db: Db }) => Promise<Response>;

interface DepsOverride {
  streamReviewTaskFn?: StreamReviewTaskFn;
}

async function drainResponse(response: Response): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;
  try {
    while (true) {
      const { done } = await reader.read();
      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
}

export async function runKnowledgeMaintenanceNightly(
  db: Db,
  deps: DepsOverride = {},
): Promise<KnowledgeMaintenanceNightlyResult> {
  const beforeRows = await listProposalInboxRows(db);
  const beforeIds = new Set(beforeRows.map((row) => row.id));
  const run = deps.streamReviewTaskFn ?? streamReviewTask;

  const response = await run({ db });
  await drainResponse(response);

  const afterRows = await listProposalInboxRows(db);
  return {
    processed: 1,
    proposals_created: afterRows.filter((row) => !beforeIds.has(row.id)).length,
    pending_after: afterRows.filter((row) => row.status === 'pending').length,
  };
}

export function buildKnowledgeMaintenanceNightlyHandler(
  db: Db,
): (jobs: Job<Record<string, never>>[]) => Promise<void> {
  return async () => {
    try {
      const result = await runKnowledgeMaintenanceNightly(db);
      console.log('[knowledge_maintenance_nightly] result', result);
    } catch (err) {
      console.error('[knowledge_maintenance_nightly] failed', err);
      throw err;
    }
  };
}
