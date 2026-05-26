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

// YUK-68 (PR #117 codex P1): streamTask encodes failures in the stream body
// (see src/server/ai/runner.ts ~L597 — `\n\n[streamTask] <msg>\n`). The
// previous drainResponse only consumed bytes, so timeout / auth / network
// failures returned `{ processed: 1 }` and pg-boss marked the run successful;
// nightly maintenance silently stopped producing proposals. We now capture
// the body and throw on the error marker so pg-boss retries / alerts.
async function drainResponseText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let acc = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) acc += decoder.decode(value, { stream: true });
    }
    acc += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return acc;
}

const STREAM_ERROR_MARKER = /\[streamTask\][^\n]*/;

export async function runKnowledgeMaintenanceNightly(
  db: Db,
  deps: DepsOverride = {},
): Promise<KnowledgeMaintenanceNightlyResult> {
  const beforeRows = await listProposalInboxRows(db);
  const beforeIds = new Set(beforeRows.map((row) => row.id));
  const run = deps.streamReviewTaskFn ?? streamReviewTask;

  const response = await run({ db });
  const body = await drainResponseText(response);
  const errorMatch = body.match(STREAM_ERROR_MARKER);
  if (errorMatch) {
    throw new Error(`knowledge_maintenance_nightly streamTask failure: ${errorMatch[0].trim()}`);
  }

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
