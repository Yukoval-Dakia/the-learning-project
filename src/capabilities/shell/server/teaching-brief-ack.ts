// YUK-708 (P0F/4) — the append-only, idempotent teaching-brief outcome
// acknowledgement writer.
//
// Contract (LAW): docs/design/2026-07-19-teaching-brief-contract.md §4.2.
//   - "outcome 目前没有持久 acknowledgement SoT. P0F/4 将新增 append-only、幂等
//      acknowledgement event."
//   - "ack 只追加事件，绝不更新 proposal、question 或 result event." — this module
//     writes exactly ONE `experimental:brief_acknowledged` event and mutates nothing.
//   - "已 ack 的 result 立即失去 eligibility" — the read model (teaching-brief.ts)
//     excludes any probe_result that has an ack event; this writer only appends it.
//
// ND-5 (contract §10): zero FSRS / mastery_state / θ̂ / calibration writes. The sole
// write is the append-only ack event; no learner-state row is ever touched.
//
// Idempotency (acceptance items 4/5): one effective ack per outcome. The ack is keyed
// on the probe_result event id — `(action=BRIEF_ACK_ACTION, subject_kind='event',
// subject_id=<result id>)`. An existing ack short-circuits to idempotent:true BEFORE any
// deliverability check (so a successful retry still resolves even after the proposal was
// retracted or the probe drifted). A per-target advisory lock (hashtextextended on the
// result id, mirroring answerProbe) serializes the first-write race so two "知道了" clicks
// can never both insert.
//
// Deliverability (acceptance items 6/8, review rounds 1–5): a FIRST ack must target the
// outcome the reader would currently deliver. Rather than re-derive each dimension, it
// reuses the reader's own primary selection (loadOutcomeBrief) and requires the target to
// BE that primary — so the writer's ackable set is identical to the reader's delivered set:
// canonical body, TTL window, chain (probe + accepted proposal), correction folding, AND
// selection (an older outcome hidden behind a newer primary is not ackable and resurfaces
// once the newer one is acked — contract §4.2/§5).

import { loadOutcomeBrief } from '@/capabilities/shell/server/teaching-brief';
import { newId } from '@/core/ids';
import { BRIEF_ACK_ACTION } from '@/core/schema/conjecture';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { ApiError } from '@/server/http/errors';
import { and, eq, sql } from 'drizzle-orm';

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

/**
 * Read an existing ack for a result as an idempotent result, or null. brief_id comes from
 * the ack's OWN payload (not from re-validating the outcome chain), so a completed ack
 * still resolves after the proposal was retracted or the probe drifted. Accepts a Db or Tx
 * so the caller can pre-check without the lock and re-check inside it.
 */
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
  // brief_id is our own append-only payload; a missing/empty one is a real data-integrity
  // signal (the wire contract requires min(1)), so surface it loudly rather than papering it
  // over with '' (which would violate the response schema). Round-5 OCR minor.
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
 * Acknowledge a delivered teaching-brief outcome. Appends exactly one
 * `experimental:brief_acknowledged` event keyed on the probe_result event, or
 * short-circuits to the existing ack when one is already recorded.
 *
 * Idempotency wins over the deliverability check: an already-recorded ack returns
 * idempotent:true BEFORE any validation, so a retry after a lost response succeeds even if
 * the proposal was since retracted or the probe drifted (round-3, codex P2). A FIRST ack is
 * fail-closed: 404 when the result event is absent; 409 (`not_current_primary`) when the
 * target is not the outcome the reader would currently deliver — corrupt/orphan/expired
 * results, and an older outcome temporarily hidden behind a newer primary, all fail here and
 * (for the older one) resurface once the newer is acked (contract §4.2/§5). We only READ
 * provenance, never write derived status back onto proposal/question/result (contract §4.2).
 */
export async function acknowledgeTeachingBriefOutcome(
  db: Db,
  probeResultEventId: string,
  now: Date = new Date(),
): Promise<AcknowledgeBriefResult> {
  // Idempotent short-circuit FIRST, before any deliverability check: an already-recorded ack
  // is immutable + append-only, so returning it is always correct regardless of whether the
  // outcome is still deliverable now. Re-gating a successful retry would surface a completed
  // ack as a failure (round-3, codex P2). Safe without the lock; the lock below closes the
  // first-write race.
  const prior = await findExistingAck(db, probeResultEventId);
  if (prior) return prior;

  // First ack — a 404 for a non-existent result (precise), then defer the WHOLE
  // deliverability judgment to the reader itself: require the target to be exactly the
  // outcome loadOutcomeBrief would currently deliver. This makes the writer's ackable set
  // identical to the reader's delivered set — every dimension (canonical, TTL window, chain,
  // correction folding) plus SELECTION — with zero re-derivation (round-5, codex P2).
  const [result] = await db
    .select({ id: event.id })
    .from(event)
    .where(eq(event.id, probeResultEventId))
    .limit(1);
  if (!result) {
    throw new ApiError(
      'brief_result_not_found',
      `no probe_result event ${probeResultEventId}`,
      404,
    );
  }
  const primaryOutcome = await loadOutcomeBrief(db, now);
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

  // Append under the per-target advisory lock; re-check inside the lock so two concurrent
  // first-writes still produce exactly one anchor (the loser returns idempotent:true).
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${probeResultEventId}, 0))`);

    const racing = await findExistingAck(tx, probeResultEventId);
    if (racing) return racing;

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
