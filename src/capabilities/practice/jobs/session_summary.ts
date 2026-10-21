// pg-boss handler for SessionSummaryTask.
//
// Enqueued by canonical `PATCH /api/review-sessions/[id]` and its legacy `/end`
// alias when the transition reaches completed. Runs async so the LLM call doesn't
// block the close request (and survives the page being closed mid-flight).

import type { Job } from 'pg-boss';

import { type RunTaskFn, runSessionSummary } from '@/capabilities/practice/server/session-summary';
import { makePracticeTaskTextRunFn } from '@/capabilities/practice/server/task-runtime';
import type { Db } from '@/db/client';

export interface SessionSummaryJobData {
  session_id: string;
}

type DepsOverride = {
  runTaskFn?: RunTaskFn;
};

export function buildSessionSummaryHandler(
  db: Db,
  deps: DepsOverride = {},
): (jobs: Job<SessionSummaryJobData>[]) => Promise<void> {
  const runTaskFn = deps.runTaskFn ?? makePracticeTaskTextRunFn(db);
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
