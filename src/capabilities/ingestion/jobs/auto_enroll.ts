// Auto-enroll consumer.
//
// Enqueued after a successful extraction. It tags and enrolls a bounded set of draft
// blocks; a page longer than the per-delivery ceiling continues in a fresh delivery
// from the returned cursor. Enrollment has no feature switch.
//
// Failure boundary: per-block tagging/enrollment faults are handled INSIDE the runner
// (tagging failure enrols with `knowledge: 'missing'`; one bad block stays draft while
// the rest continue). This handler re-throws everything that escapes — including a
// failed cursor enqueue — so pg-boss retries this cheap job in isolation, never the
// expensive OCR job and never the session status. The per-block FOR UPDATE claim makes
// a retry idempotent; blocks already enrolled are no longer draft, so repeated paid
// tagging is bounded by the still-draft blocks of the batch (≤ AUTO_ENROLL_MAX_BLOCKS_PER_RUN).

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
        // singleton key so the follow-up is not collapsed into this delivery. A failed
        // send must fail the delivery: swallowing it would strand every block past the
        // cursor as draft forever (YUK-1994 review).
        if (result.next_after_block !== null) {
          const boss = await getStartedBoss();
          await boss.send(
            'auto_enroll',
            { sessionId, afterBlock: result.next_after_block },
            {
              singletonKey: `${sessionId}:${result.next_after_block.id}`,
              singletonSeconds: AUTO_ENROLL_SINGLETON_SECONDS,
            },
          );
        }
      } catch (err) {
        // Everything inside the runner that is block-scoped is already absorbed; an
        // escape means this delivery could not finish, so pg-boss must retry it.
        console.error(`[auto_enroll] ${sessionId} failed`, err);
        throw err;
      }
    }
  };
}
