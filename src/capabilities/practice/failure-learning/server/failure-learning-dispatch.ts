// Durable dispatch for attribution_followup. The subscription's business
// transaction writes only the intent event; this drain — the single recovery
// owner — sends outside any transaction under the stable stage job id and
// writes the acceptance event only after the engine accepted the delivery.
import { and, eq, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Job } from 'pg-boss';
import { z } from 'zod';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { getRunningBoss } from '@/server/boss/client';
import {
  type FailureLearningBossSend,
  enqueueAttributionFollowup,
} from '../jobs/failure-learning-jobs';
import { ATTRIBUTION_FOLLOWUP_QUEUE, failureLearningJobId } from './failure-learning-identity';

export const FAILURE_LEARNING_DISPATCH_INTENT_ACTION =
  'experimental:failure_learning_dispatch_intent';
export const FAILURE_LEARNING_DISPATCH_ACTION = 'experimental:failure_learning_dispatch';

const DISPATCH_DRAIN_BATCH = 50;

const dispatchIntentPayloadSchema = z.object({
  version: z.literal(1),
  queue: z.literal(ATTRIBUTION_FOLLOWUP_QUEUE),
  attempt_event_id: z.string().min(1),
  job_id: z.string().uuid(),
});

export function failureLearningDispatchIntentId(jobId: string): string {
  return `failure-learning-dispatch-intent-${jobId}`;
}

export function failureLearningDispatchEventId(jobId: string): string {
  return `failure-learning-dispatch-${jobId}`;
}

/** Persist the durable obligation inside the caller's transaction. writeEvent
 * is insert-only, so a replayed subscription delivery reports the same job id
 * instead of minting a second obligation. */
export async function writeFailureLearningDispatchIntent(
  tx: Db | Tx,
  attemptEventId: string,
): Promise<string> {
  const jobId = failureLearningJobId(ATTRIBUTION_FOLLOWUP_QUEUE, attemptEventId);
  const now = new Date();
  await writeEvent(tx, {
    id: failureLearningDispatchIntentId(jobId),
    actor_kind: 'system',
    actor_ref: 'failure_learning_dispatch',
    action: FAILURE_LEARNING_DISPATCH_INTENT_ACTION,
    subject_kind: 'event',
    subject_id: attemptEventId,
    outcome: null,
    payload: {
      version: 1,
      queue: ATTRIBUTION_FOLLOWUP_QUEUE,
      attempt_event_id: attemptEventId,
      job_id: jobId,
    },
    created_at: now,
    // Self-stamp: system dispatch rows never feed memory derivation.
    ingest_at: now,
  });
  return jobId;
}

export interface FailureLearningDispatchResult {
  scanned: number;
  dispatched: number;
  failed: number;
}

// Pending = intent ∧ no acceptance event. SKIP LOCKED partitions concurrent
// drains; the engine's stable-id dedup is the actual once-only barrier, so an
// overlapped pass still converges on one delivery.
async function selectPendingDispatch(
  db: Db | Tx,
  input: { attemptEventId?: string; batchSize: number },
) {
  const completion = alias(event, 'failure_learning_dispatch_done');
  return db
    .select({ id: event.id, payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, FAILURE_LEARNING_DISPATCH_INTENT_ACTION),
        input.attemptEventId ? eq(event.subject_id, input.attemptEventId) : undefined,
        notExists(
          db
            .select({ id: completion.id })
            .from(completion)
            .where(
              and(
                eq(completion.action, FAILURE_LEARNING_DISPATCH_ACTION),
                sql`${completion.payload}->>'job_id' = ${event.payload}->>'job_id'`,
              ),
            ),
        ),
      ),
    )
    .orderBy(event.created_at, event.id)
    .limit(input.batchSize)
    .for('update', { skipLocked: true });
}

export async function drainFailureLearningDispatch(
  db: Db,
  send: FailureLearningBossSend,
  input: { attemptEventId?: string; batchSize?: number } = {},
): Promise<FailureLearningDispatchResult> {
  const rows = await db.transaction((tx) =>
    selectPendingDispatch(tx, {
      attemptEventId: input.attemptEventId,
      batchSize: input.batchSize ?? DISPATCH_DRAIN_BATCH,
    }),
  );
  const result: FailureLearningDispatchResult = {
    scanned: rows.length,
    dispatched: 0,
    failed: 0,
  };
  for (const row of rows) {
    const parsed = dispatchIntentPayloadSchema.safeParse(row.payload);
    if (!parsed.success) continue;
    try {
      // Resolves once the engine holds the delivery; a duplicate stable id
      // returns the pre-existing identical job.
      await enqueueAttributionFollowup(send, parsed.data.attempt_event_id);
      const now = new Date();
      await writeEvent(db, {
        id: failureLearningDispatchEventId(parsed.data.job_id),
        actor_kind: 'system',
        actor_ref: 'failure_learning_dispatch',
        action: FAILURE_LEARNING_DISPATCH_ACTION,
        subject_kind: 'event',
        subject_id: parsed.data.attempt_event_id,
        outcome: 'success',
        payload: {
          version: 1,
          queue: ATTRIBUTION_FOLLOWUP_QUEUE,
          attempt_event_id: parsed.data.attempt_event_id,
          job_id: parsed.data.job_id,
          backend: 'pgboss',
        },
        created_at: now,
        ingest_at: now,
      });
      result.dispatched += 1;
    } catch (error) {
      result.failed += 1;
      console.error('[failure_learning_dispatch] engine send failed; intent stays pending', {
        attempt_event_id: parsed.data.attempt_event_id,
        error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      });
    }
  }
  return result;
}

/** Cron drain: the single recovery owner for intents whose acceptance event
 * never landed (engine down at delivery, crash between commit and send, or a
 * lost subscription wake). */
export function buildFailureLearningDispatchHandler(
  db: Db,
): (jobs: Job<object>[]) => Promise<FailureLearningDispatchResult> {
  return async () => {
    const boss = getRunningBoss();
    if (!boss) {
      throw new Error('failure learning dispatch requires the running pg-boss');
    }
    return drainFailureLearningDispatch(db, boss.send.bind(boss) as FailureLearningBossSend);
  };
}
