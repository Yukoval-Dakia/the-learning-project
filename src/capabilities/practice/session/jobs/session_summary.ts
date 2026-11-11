// pg-boss handler for SessionSummaryTask.
//
// Enqueued by canonical `PATCH /api/review-sessions/[id]` and its legacy `/end`
// alias when the transition reaches completed, by the daily stream when a
// KC-scoped session's last item closes, and by the orphan sweep for abandoned
// sessions (the runner itself skips sessions with no answers). Runs async so the
// LLM call doesn't block the close request (and survives the page being closed
// mid-flight).
//
// Attribution can land after the session closes. The runner waits a bounded
// number of delayed attempts instead of writing a thin summary; if causes are
// still missing at the last wait it writes anyway and schedules one late refresh
// so a slow attribution still gets folded in.

import { createHash } from 'node:crypto';
import type { Job } from 'pg-boss';
import {
  type RunTaskFn,
  runSessionSummary,
} from '@/capabilities/practice/session/server/session-summary';
import type { Db } from '@/db/client';
import { shouldEnqueueBackgroundJobs } from '@/kernel/background-job-enqueue';
import { makeRunTaskTextFn } from '@/server/ai/runner-fn';
import { getStartedBoss } from '@/server/boss/client';

export const SESSION_SUMMARY_JOB = 'session_summary';
/** Delayed tries while this session's failure attribution is still missing. */
export const MAX_ATTRIBUTION_WAITS = 5;
const ATTRIBUTION_WAIT_MS = 30_000;
/** One late pass folds in attribution that missed the bounded wait window. */
const REFRESH_DELAY_MS = 10 * 60_000;

export interface SessionSummaryJobData {
  session_id: string;
  /** 0 on the first delivery; incremented by each delayed wait. */
  attribution_wait_attempt?: number;
  /** The single late pass that runs after a summary was written with causes pending. */
  attribution_refresh?: boolean;
}

type DepsOverride = {
  runTaskFn?: RunTaskFn;
};

/** Stable RFC 9562 UUIDv8 seeded by the session: every close/retry for that
 *  session converges on the same delayed follow-up instead of fanning out. */
function summaryFollowUpJobId(sessionId: string, attempt: number, refresh: boolean): string {
  const hex = createHash('sha256')
    .update(
      `practice.session-summary@v1\0${sessionId}\0${attempt}\0${refresh ? 'refresh' : 'wait'}`,
    )
    .digest('hex');
  const bytes = hex.slice(0, 32).split('');
  bytes[12] = '8';
  bytes[16] = ((Number.parseInt(bytes[16], 16) & 0x3) | 0x8).toString(16);
  const value = bytes.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}

async function scheduleFollowUp(
  data: SessionSummaryJobData,
  attempt: number,
  refresh: boolean,
  startAfter: Date,
): Promise<void> {
  if (!shouldEnqueueBackgroundJobs()) return;
  const boss = await getStartedBoss();
  await boss.send(
    SESSION_SUMMARY_JOB,
    {
      session_id: data.session_id,
      attribution_wait_attempt: attempt,
      ...(refresh ? { attribution_refresh: true } : {}),
    },
    { id: summaryFollowUpJobId(data.session_id, attempt, refresh), startAfter },
  );
}

export function buildSessionSummaryHandler(
  db: Db,
  deps: DepsOverride = {},
): (jobs: Job<SessionSummaryJobData>[]) => Promise<void> {
  const runTaskFn = deps.runTaskFn ?? makeRunTaskTextFn(db);
  return async (jobs) => {
    for (const job of jobs) {
      const sessionId = job.data?.session_id;
      if (!sessionId) {
        console.warn('[session_summary] job missing session_id', job.id);
        continue;
      }
      const attempt = job.data.attribution_wait_attempt ?? 0;
      const refresh = job.data.attribution_refresh === true;
      try {
        const result = await runSessionSummary({
          db,
          sessionId,
          runTaskFn,
          attributionWait: { attempt, maxWaits: MAX_ATTRIBUTION_WAITS },
          refresh,
        });
        console.log(
          `[session_summary] ${sessionId} → ${result.status}` +
            (result.issues?.length ? ` (${result.issues.length} number issues)` : ''),
        );
        if (result.status === 'skipped:attribution_pending') {
          // The runner refuses to write before the last wait, so a pending result
          // always has room for one more delayed try. A failed send must retry this
          // cheap delivery: nothing was written and no model call was made.
          await scheduleFollowUp(
            job.data,
            attempt + 1,
            false,
            new Date(Date.now() + ATTRIBUTION_WAIT_MS),
          );
        } else if (!refresh && (result.pending_attribution ?? 0) > 0) {
          // The summary is already written. A lost refresh degrades to the
          // causes_pending record on the event, so never re-run the paid task just
          // because the follow-up send failed.
          try {
            await scheduleFollowUp(
              job.data,
              MAX_ATTRIBUTION_WAITS,
              true,
              new Date(Date.now() + REFRESH_DELAY_MS),
            );
          } catch (err) {
            console.warn(`[session_summary] ${sessionId} refresh enqueue failed`, err);
          }
        }
      } catch (err) {
        console.error(`[session_summary] ${sessionId} failed`, err);
        throw err; // let pg-boss retry per its config
      }
    }
  };
}
