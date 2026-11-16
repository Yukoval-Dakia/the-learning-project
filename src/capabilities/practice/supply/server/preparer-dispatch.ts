// Durable dispatch for question_preparer_run. The business transaction writes
// one intent event carrying the complete job data and a stable delivery id —
// never a summary, the ticket cannot be rebuilt from knowledge_ids alone. This
// drain — the journal's only sender — sends outside any transaction under that
// id, reads the engine back on an ambiguous return, and writes the acceptance
// event only after the engine holds the delivery. Same-id resends dedupe at
// the engine, so overlapping drains converge on one delivery.
import { randomUUID } from 'node:crypto';
import { and, eq, notExists, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { JobWithMetadata } from 'pg-boss';
import { z } from 'zod';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { JOB_RETRY_DELAY_SECONDS, JOB_RETRY_LIMIT } from '@/server/boss/queue-config';
import { QuestionPreparerJobData } from './question-preparer-contract';

export const QUESTION_PREPARER_QUEUE = 'question_preparer_run' as const;
export const PREPARER_DISPATCH_INTENT_ACTION = 'experimental:question_preparer_dispatch_intent';
export const PREPARER_DISPATCH_ACTION = 'experimental:question_preparer_dispatch';

const DISPATCH_DRAIN_BATCH = 50;
const LIVE_JOB_STATES: ReadonlySet<string> = new Set(['created', 'retry', 'active']);

const preparerDispatchSendSchema = z.object({
  singleton_key: z.string().min(1).optional(),
  /** ISO instant; mapped to pg-boss startAfter at send time. */
  not_before: z.string().min(1).optional(),
  retry_limit: z.number().int().nonnegative().optional(),
  retry_delay_seconds: z.number().int().nonnegative().optional(),
  retry_backoff: z.boolean().optional(),
});

const preparerDispatchIntentSchema = z.object({
  version: z.literal(1),
  queue: z.literal(QUESTION_PREPARER_QUEUE),
  kind: z.enum(['ticket', 'wait', 'recovery']),
  job_id: z.string().uuid(),
  demand_id: z.string().min(1),
  /** Complete job payload; the drain never reconstructs it from summaries. */
  data: QuestionPreparerJobData,
  send: preparerDispatchSendSchema,
});
type PreparerDispatchIntent = z.infer<typeof preparerDispatchIntentSchema>;

export type PreparerDispatchKind = PreparerDispatchIntent['kind'];

export function parsePreparerDispatchIntent(payload: unknown): PreparerDispatchIntent | null {
  const parsed = preparerDispatchIntentSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

export function preparerDispatchIntentEventId(jobId: string): string {
  return `question-preparer-dispatch-intent-${jobId}`;
}

export function preparerDispatchEventId(jobId: string): string {
  return `question-preparer-dispatch-${jobId}`;
}

/** Persist the durable obligation inside the caller's transaction. Mints and
 * returns the stable delivery id; writeEvent is insert-only, so a replayed
 * producer reports the same id instead of a second obligation. */
export async function writePreparerDispatchIntent(
  tx: Db | Tx,
  input: {
    kind: PreparerDispatchKind;
    data: z.infer<typeof QuestionPreparerJobData>;
    send?: z.infer<typeof preparerDispatchSendSchema>;
    jobId?: string;
  },
): Promise<string> {
  const jobId = input.jobId ?? randomUUID();
  const now = new Date();
  const payload: PreparerDispatchIntent = {
    version: 1,
    queue: QUESTION_PREPARER_QUEUE,
    kind: input.kind,
    job_id: jobId,
    demand_id: input.data.ticket.demand_id,
    data: input.data,
    send: input.send ?? {},
  };
  await writeEvent(tx, {
    id: preparerDispatchIntentEventId(jobId),
    actor_kind: 'system',
    actor_ref: 'question_preparer_dispatch',
    action: PREPARER_DISPATCH_INTENT_ACTION,
    subject_kind: 'query',
    subject_id: payload.demand_id,
    outcome: null,
    payload,
    created_at: now,
    // Self-stamp: dispatch rows never feed memory derivation.
    ingest_at: now,
  });
  return jobId;
}

export interface PreparerDispatchBoss {
  send(
    name: typeof QUESTION_PREPARER_QUEUE,
    data: z.infer<typeof QuestionPreparerJobData>,
    options: {
      id: string;
      startAfter?: Date;
      singletonKey?: string;
      retryLimit?: number;
      retryDelay?: number;
      retryBackoff?: boolean;
    },
  ): Promise<string | null>;
  getJobById(
    name: typeof QUESTION_PREPARER_QUEUE,
    id: string,
  ): Promise<Pick<JobWithMetadata, 'state'> | null>;
}

/** Engine-acceptance receipt, keyed by the bound delivery id. Deterministic
 * event id makes concurrent drains and post-acceptance replays no-ops. */
async function writePreparerDispatchReceipt(
  db: Db,
  intent: PreparerDispatchIntent,
  engineState: 'sent' | 'live' | 'terminal',
): Promise<void> {
  const now = new Date();
  await writeEvent(db, {
    id: preparerDispatchEventId(intent.job_id),
    actor_kind: 'system',
    actor_ref: 'question_preparer_dispatch',
    action: PREPARER_DISPATCH_ACTION,
    subject_kind: 'query',
    subject_id: intent.demand_id,
    outcome: 'success',
    payload: {
      version: 1,
      job_id: intent.job_id,
      kind: intent.kind,
      backend: 'pgboss',
      engine_state: engineState,
    },
    created_at: now,
    ingest_at: now,
  });
}

export interface QuestionPreparerDispatchResult {
  scanned: number;
  dispatched: number;
  /** Already accepted at the engine; only the receipt was owed. */
  live: number;
  /** Engine row terminal — accepted, business verdict belongs to the journal. */
  terminal: number;
  failed: number;
}

// Pending = intent ∧ no acceptance receipt. SKIP LOCKED partitions concurrent
// drains inside the select tx; the engine's stable-id dedup is the once-only
// barrier once locks release, so an overlapped pass still converges.
async function selectPendingDispatch(db: Db | Tx, input: { jobId?: string; batchSize: number }) {
  const receipt = alias(event, 'preparer_dispatch_done');
  return db
    .select({ id: event.id, payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, PREPARER_DISPATCH_INTENT_ACTION),
        input.jobId ? sql`${event.payload}->>'job_id' = ${input.jobId}` : undefined,
        notExists(
          db
            .select({ id: receipt.id })
            .from(receipt)
            .where(
              and(
                eq(receipt.action, PREPARER_DISPATCH_ACTION),
                sql`${receipt.payload}->>'job_id' = ${event.payload}->>'job_id'`,
              ),
            ),
        ),
      ),
    )
    .orderBy(event.created_at, event.id)
    .limit(input.batchSize)
    .for('update', { skipLocked: true });
}

function sendOptionsFor(intent: PreparerDispatchIntent, now: Date) {
  const notBefore = intent.send.not_before ? new Date(intent.send.not_before) : null;
  return {
    id: intent.job_id,
    ...(intent.send.singleton_key ? { singletonKey: intent.send.singleton_key } : {}),
    ...(notBefore && notBefore.getTime() > now.getTime() ? { startAfter: notBefore } : {}),
    ...(intent.send.retry_limit != null ? { retryLimit: intent.send.retry_limit } : {}),
    ...(intent.send.retry_delay_seconds != null
      ? { retryDelay: intent.send.retry_delay_seconds }
      : {}),
    ...(intent.send.retry_backoff != null ? { retryBackoff: intent.send.retry_backoff } : {}),
  };
}

export async function drainQuestionPreparerDispatch(
  db: Db,
  boss: PreparerDispatchBoss,
  input: { jobId?: string; batchSize?: number; now?: Date } = {},
): Promise<QuestionPreparerDispatchResult> {
  const now = input.now ?? new Date();
  const rows = await db.transaction((tx) =>
    selectPendingDispatch(tx, {
      jobId: input.jobId,
      batchSize: input.batchSize ?? DISPATCH_DRAIN_BATCH,
    }),
  );
  const result: QuestionPreparerDispatchResult = {
    scanned: rows.length,
    dispatched: 0,
    live: 0,
    terminal: 0,
    failed: 0,
  };
  for (const row of rows) {
    const parsed = preparerDispatchIntentSchema.safeParse(row.payload);
    if (!parsed.success) continue;
    const intent = parsed.data;
    try {
      const existing = await boss.getJobById(QUESTION_PREPARER_QUEUE, intent.job_id);
      if (existing) {
        await writePreparerDispatchReceipt(
          db,
          intent,
          LIVE_JOB_STATES.has(existing.state ?? '') ? 'live' : 'terminal',
        );
        if (LIVE_JOB_STATES.has(existing.state ?? '')) result.live += 1;
        else result.terminal += 1;
        continue;
      }
      // Outside any transaction: the engine's own id dedup is the once-only
      // barrier. A null return names a pre-existing row — read it back.
      const sent = await boss.send(
        QUESTION_PREPARER_QUEUE,
        intent.data,
        sendOptionsFor(intent, now),
      );
      if (sent !== null) {
        await writePreparerDispatchReceipt(db, intent, 'sent');
        result.dispatched += 1;
        continue;
      }
      const readBack = await boss.getJobById(QUESTION_PREPARER_QUEUE, intent.job_id);
      if (readBack) {
        await writePreparerDispatchReceipt(
          db,
          intent,
          LIVE_JOB_STATES.has(readBack.state ?? '') ? 'live' : 'terminal',
        );
        if (LIVE_JOB_STATES.has(readBack.state ?? '')) result.live += 1;
        else result.terminal += 1;
        continue;
      }
      // Deduped id with no engine row: pathological (swept identity). Leave
      // the intent pending; the next pass retries the same bound id.
      result.failed += 1;
      console.error(
        `[question_preparer_dispatch] engine deduped ${intent.job_id} but no row exists; intent stays pending`,
      );
    } catch (error) {
      result.failed += 1;
      console.error(
        `[question_preparer_dispatch] engine send failed for ${intent.job_id}; intent stays pending`,
        error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      );
    }
  }
  return result;
}

/** The retry options a ticket-bound first delivery always carried. */
export const PREPARER_TICKET_SEND = {
  retry_limit: JOB_RETRY_LIMIT,
  retry_delay_seconds: JOB_RETRY_DELAY_SECONDS,
  retry_backoff: true,
} as const;
