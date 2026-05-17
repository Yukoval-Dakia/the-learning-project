// Phase 1d — pg-boss handler for SessionSummaryTask.
//
// Enqueued by the `/api/review/sessions/[id]/end` route after a review session
// transitions to completed. Picks the job up async so the LLM call doesn't
// block the close request (and survives the page being closed mid-flight).

import type { Job } from 'pg-boss';

import type { Db } from '@/db/client';
import { type RunTaskFn, runSessionSummary } from '@/server/session/summary';

export interface SessionSummaryJobData {
  session_id: string;
}

type DepsOverride = {
  runTaskFn?: RunTaskFn;
};

async function defaultRunTaskFn(
  kind: string,
  input: unknown,
  ctx: unknown,
): Promise<{ text: string }> {
  const { runTask } = await import('@/server/ai/runner');
  const result = await runTask(kind, input, ctx as Parameters<typeof runTask>[2]);
  return { text: result.text };
}

export function buildSessionSummaryHandler(
  db: Db,
  deps: DepsOverride = {},
): (jobs: Job<SessionSummaryJobData>[]) => Promise<void> {
  const runTaskFn = deps.runTaskFn ?? defaultRunTaskFn;
  return async (jobs) => {
    for (const job of jobs) {
      const sessionId = job.data?.session_id;
      if (!sessionId) {
        console.warn('[session_summary] job missing session_id', job.id);
        continue;
      }
      try {
        const result = await runSessionSummary({ db, sessionId, runTaskFn });
        console.log(`[session_summary] ${sessionId} → ${result.status}`);
      } catch (err) {
        console.error(`[session_summary] ${sessionId} failed`, err);
        throw err; // let pg-boss retry per its config
      }
    }
  };
}
