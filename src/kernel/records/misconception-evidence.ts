// Misconception recurrence-evidence writer.
//
// When a NEW effective wrong-answer attribution selects an existing misc_ misconception,
// this hop records the recurrence inside the caller's attribution transaction:
//   1. atomically increments misconception.seen;
//   2. appends the attempt event id to the node's evidence event-ptr array;
//   3. upserts an observed_in edge (misconception -> attempt event) through the
//      misconception-edges throat, reactivating it — a fresh recurrence legitimately
//      revives the pair's provenance row, so `seen` never counts an observation whose
//      edge stays invisible.
//
// Idempotency is the persisted (misconception, event) pair: ANY durable marker that the
// pair was already recorded — the event id inside misconception.evidence, or a live
// observed_in edge — makes the hop a replay that writes nothing, so redelivery or a
// concurrent same-attempt attribution counts once. Both markers come from the same
// committed hop, and a post-hoc archive of the edge does not reopen the count.
// Concurrency is serialized by the `misc:<id>` xact advisory lock, the same namespace
// the promote writer uses, so accept-time upserts and recurrence recordings cannot
// interleave.
//
// SOFT track: seen/evidence are salience + provenance only; nothing here feeds mastery,
// theta, FSRS, or difficulty. Callers pass only ids the LLM selected; selection itself
// stays in the attribution owner.

import { and, eq, isNull, sql } from 'drizzle-orm';

import type { Tx } from '@/db/client';
import { acquireSortedAdvisoryLocks } from '@/db/learning-state-lock';
import { misconception, misconception_edge } from '@/db/schema';
import { createMisconceptionEdge } from '@/kernel/records/misconception-edges';

export interface RecordMisconceptionRecurrenceInput {
  /** Misconception row id (the selected misc_ cause id). */
  misconceptionId: string;
  /** Attempt event the recurrence was observed in. */
  attemptEventId: string;
  /** Caller-supplied write instant (house convention — no defaultNow). */
  now: Date;
}

export interface RecordMisconceptionRecurrenceResult {
  /**
   * 'recorded' = this hop wrote the recurrence (seen +1, evidence appended, edge
   * live). 'replayed' = the pair was already recorded (evidence ptr or live edge) and
   * nothing was written. 'skipped' = the node was archived/inactive/missing, or a
   * non-locking writer raced the guarded update — the judge write stays intact.
   */
  status: 'recorded' | 'replayed' | 'skipped';
}

/**
 * Record one recurrence of `misconceptionId` observed in `attemptEventId`. Runs
 * INSIDE the caller's attribution transaction so the judge event and the evidence
 * hop commit or roll back together.
 */
export async function recordMisconceptionRecurrence(
  tx: Tx,
  input: RecordMisconceptionRecurrenceInput,
): Promise<RecordMisconceptionRecurrenceResult> {
  // Share the promotion/archive writer's `misc:<id>` transaction lock so the
  // evidence update and edge upsert serialize with accepts and archives.
  await acquireSortedAdvisoryLocks(tx, 'misc', [input.misconceptionId]);

  // Read the node under the lock: replay detection needs its evidence array, and the
  // active/archived guard decides whether recording is even possible.
  const nodes = await tx
    .select({
      status: misconception.status,
      archived_at: misconception.archived_at,
      evidence: misconception.evidence,
    })
    .from(misconception)
    .where(eq(misconception.id, input.misconceptionId))
    .limit(1);
  const node = nodes[0];
  if (node?.status !== 'active' || node.archived_at !== null) return { status: 'skipped' };

  // Persisted (misconception, event) idempotency: the pair was already recorded iff
  // the evidence array carries the event id OR a live observed_in edge exists. The
  // edge read runs only when the cheap array check misses.
  if (node.evidence.includes(input.attemptEventId)) return { status: 'replayed' };
  const liveEdge = await tx
    .select({ id: misconception_edge.id })
    .from(misconception_edge)
    .where(
      and(
        eq(misconception_edge.from_kind, 'misconception'),
        eq(misconception_edge.from_id, input.misconceptionId),
        eq(misconception_edge.to_kind, 'event'),
        eq(misconception_edge.to_id, input.attemptEventId),
        eq(misconception_edge.relation_type, 'observed_in'),
        isNull(misconception_edge.archived_at),
      ),
    )
    .limit(1);
  if (liveEdge.length > 0) return { status: 'replayed' };

  // New recurrence: atomic `seen + 1` and evidence append. The guards re-check under
  // the same statement — a non-locking writer racing the hop turns the update into a
  // no-op reported as skipped, never a double count.
  const updated = await tx
    .update(misconception)
    .set({
      seen: sql`${misconception.seen} + 1`,
      evidence: sql`${misconception.evidence} || ${JSON.stringify([input.attemptEventId])}::jsonb`,
      updated_at: input.now,
    })
    .where(
      and(
        eq(misconception.id, input.misconceptionId),
        eq(misconception.status, 'active'),
        isNull(misconception.archived_at),
        sql`NOT (${misconception.evidence} @> ${JSON.stringify([input.attemptEventId])}::jsonb)`,
      ),
    )
    .returning({ id: misconception.id });
  if (updated.length === 0) return { status: 'skipped' };

  // Idempotent observed_in edge through the single throat. reactivate:true: if the
  // pair's row was archived after an earlier recording, this NEW recurrence revives
  // it — the provenance edge must be live whenever `seen` counts the pair.
  await createMisconceptionEdge(tx, {
    from_id: input.misconceptionId,
    to_kind: 'event',
    to_id: input.attemptEventId,
    relation_type: 'observed_in',
    created_by: { by: 'ai' },
    proposed_by_ai: true,
    now: input.now,
    reactivate: true,
  });

  return { status: 'recorded' };
}
