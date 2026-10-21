// Append-only, idempotent acknowledgement of a delivered brief outcome.
//
// The sole write is one `experimental:brief_acknowledged` event; no derived status is
// written back to proposal/question/result, and no learner-state row is touched.
//
// Idempotency (keyed on the probe_result event id) always precedes the deliverability
// verdict: a lost-response retry or a concurrent duplicate resolves to idempotent:true
// even if the proposal was retracted or the probe drifted. A per-target advisory lock
// serializes the first-write race.
//
// A first ack must target exactly the reader's current primary outcome, so the writer's
// ackable set matches the reader's delivered set without re-deriving each dimension.

import { and, eq, sql } from 'drizzle-orm';
import { loadOutcomeBrief } from '@/capabilities/shell/server/teaching-brief';
import { newId } from '@/core/ids';
import { BRIEF_ACK_ACTION, PROBE_RESULT_ACTION } from '@/core/schema/conjecture';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { writeEvent } from '@/kernel/events';
import { ApiError } from '@/kernel/http';

export interface AcknowledgeBriefResult {
  /** The append-only ack event id (existing one on an idempotent re-ack). */
  brief_acknowledgement_event_id: string;
  /** Echo of the acked outcome (probe_result) event id. */
  probe_result_event_id: string;
  /** The conjecture proposal id this outcome belongs to (from the result payload). */
  brief_id: string;
  /** true when a prior ack already existed — no second event was written. */
  idempotent: boolean;
}

/** Read an existing ack; brief_id comes from the ack's own payload so it survives drift. */
async function findExistingAck(
  db: Db | Tx,
  probeResultEventId: string,
): Promise<AcknowledgeBriefResult | null> {
  const [existing] = await db
    .select({ id: event.id, payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, BRIEF_ACK_ACTION),
        eq(event.subject_kind, 'event'),
        eq(event.subject_id, probeResultEventId),
      ),
    )
    .limit(1);
  if (!existing) return null;
  const briefId = (existing.payload as Record<string, unknown> | null)?.brief_id;
  // Missing brief_id is data corruption; fail loudly rather than violate the schema.
  if (typeof briefId !== 'string' || briefId.length === 0) {
    throw new ApiError(
      'ack_payload_corrupt',
      `ack event ${existing.id} for ${probeResultEventId} has no brief_id`,
      500,
    );
  }
  return {
    brief_acknowledgement_event_id: existing.id,
    probe_result_event_id: probeResultEventId,
    brief_id: briefId,
    idempotent: true,
  };
}

/**
 * Append one ack keyed on the probe_result event, or return the existing ack.
 * Missing result → 404; a result that is not the current primary → 409. An older
 * outcome hidden behind a newer primary becomes ackable again once the newer is acked.
 */
export async function acknowledgeTeachingBriefOutcome(
  db: Db,
  probeResultEventId: string,
  now: Date = new Date(),
): Promise<AcknowledgeBriefResult> {
  // Short-circuit first: an existing ack is immutable, so re-gating a retry would turn a
  // completed ack into a failure. The lock below closes the first-write race.
  const prior = await findExistingAck(db, probeResultEventId);
  if (prior) return prior;

  // A non-result id is a 404, not a misleading 409. Deliverability itself is delegated
  // to the reader so both sides share one definition.
  const [result] = await db
    .select({ id: event.id })
    .from(event)
    .where(and(eq(event.id, probeResultEventId), eq(event.action, PROBE_RESULT_ACTION)))
    .limit(1);
  if (!result) {
    throw new ApiError(
      'brief_result_not_found',
      `no probe_result event ${probeResultEventId}`,
      404,
    );
  }

  // Verdict and append share one transaction and the per-target lock, so the primary cannot
  // change between check and write. A racer that committed first is caught in-lock and
  // returns idempotent, not 409.
  //
  // Deliberate limitation: the lock is per target, not global selection. A writer changing
  // the primary on another chain can still commit between our last SELECT and INSERT. That
  // is acceptable — the target was the delivered primary in this snapshot, the ack is
  // append-only, and a global lock would couple pipeline throughput to UI dismissal. The
  // exact-version upgrade path is a delivery token required on ack.
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${probeResultEventId}, 0))`);

    const racing = await findExistingAck(tx, probeResultEventId);
    if (racing) return racing;

    const primaryOutcome = await loadOutcomeBrief(tx, now, { serial: true });
    if (
      primaryOutcome === null ||
      primaryOutcome.current_outcome.probe_result_event_id !== probeResultEventId
    ) {
      throw new ApiError(
        'not_current_primary',
        `event ${probeResultEventId} is not the current primary outcome`,
        409,
      );
    }
    const briefId = primaryOutcome.brief_id;

    const ackEventId = newId();
    await writeEvent(tx, {
      id: ackEventId,
      actor_kind: 'user',
      actor_ref: 'self',
      action: BRIEF_ACK_ACTION,
      subject_kind: 'event',
      subject_id: probeResultEventId,
      // Append-only ack (contract §4.2): carries only brief provenance + timestamp,
      // never the claim / answer / judge detail. It writes NO derived status back.
      payload: {
        brief_id: briefId,
        acknowledged_at: now.toISOString(),
      },
      caused_by_event_id: probeResultEventId,
      // Internal UI-dismissal ledger — opt out of memory ingestion (there is no learner
      // evidence to ingest) and keep affected_scopes empty so brief scans ignore it.
      ingest_at: now,
      created_at: now,
    });

    return {
      brief_acknowledgement_event_id: ackEventId,
      probe_result_event_id: probeResultEventId,
      brief_id: briefId,
      idempotent: false,
    };
  });
}
