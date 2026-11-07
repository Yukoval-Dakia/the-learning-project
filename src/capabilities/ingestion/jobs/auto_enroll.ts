// Observe-only auto-enroll consumer.
//
// Enqueued after a successful extraction. With enroll off and observe explicitly
// on, it tags and judges a bounded set of draft blocks and writes one durable
// observed event per block, mutating nothing. Both paid modes default off.
//
// Failure boundary: per-block tagging/judge/observe-write faults are
// swallowed INSIDE the runner (missing XIAOMI_API_KEY → TaggingTaskError →
// route-to-review; a single failed audit write logs + continues). So this
// handler-level catch does NOT guard the missing-key path. It guards only a
// genuinely-escaping fault: a non-TaggingTaskError that the runner re-raises
// (e.g. DB connection lost). We re-throw such faults so pg-boss retries on this
// queue alone — never the expensive OCR job, never the session status.

import type { Job } from 'pg-boss';

import { runAutoEnrollForSession } from '@/capabilities/ingestion/server/auto-enroll';
import { AUTO_ENROLL_SINGLETON_SECONDS } from '@/capabilities/ingestion/server/workflow-judge-config';
import type { Db } from '@/db/client';
import { getStartedBoss } from '@/server/boss/client';

export interface AutoEnrollJobData {
  sessionId: string;
  /** Cursor for the next batch of an oversized session; absent on the first delivery. */
  afterBlock?: { ordinal: number; id: string };
}

export function buildAutoEnrollHandler(db: Db): (jobs: Job<AutoEnrollJobData>[]) => Promise<void> {
  return async (jobs) => {
    for (const job of jobs) {
      const sessionId = job.data?.sessionId;
      if (!sessionId) {
        console.warn('[auto_enroll] job missing sessionId', job.id);
        continue;
      }
      try {
        const result = await runAutoEnrollForSession({
          db,
          sessionId,
          ctx: { db },
          ...(job.data.afterBlock !== undefined ? { afterBlock: job.data.afterBlock } : {}),
          providerAttempt: {
            db,
            caller: 'worker',
            deadlineAt: new Date(Date.now() + 20_000),
            operationAnchor: job.id,
          },
        });
        console.log(
          `[auto_enroll] ${sessionId} → ${result.status} (enrolled=${result.enrolled}, routed_to_review=${result.routed_to_review})`,
        );
        // One job keeps its per-delivery paid ceiling; a page longer than it continues
        // in a fresh delivery from the returned cursor. The cursor is part of the
        // singleton key so the follow-up is not collapsed into this delivery.
        if (result.next_after_block !== null) {
          try {
            const boss = await getStartedBoss();
            await boss.send(
              'auto_enroll',
              { sessionId, afterBlock: result.next_after_block },
              {
                singletonKey: `${sessionId}:${result.next_after_block.id}`,
                singletonSeconds: AUTO_ENROLL_SINGLETON_SECONDS,
              },
            );
          } catch (sendErr) {
            // Blocks past the cursor stay draft; the page can still finish them by hand.
            console.error(`[auto_enroll] ${sessionId} failed to enqueue next batch`, sendErr);
          }
        }
      } catch (err) {
        // A genuinely-escaping fault (per-block AI/missing-key/observe-write are
        // already swallowed upstream). Re-throw so pg-boss retries this cheap
        // tagging job in isolation — extraction + session status are untouched.
        console.error(`[auto_enroll] ${sessionId} failed`, err);
        throw err;
      }
    }
  };
}
