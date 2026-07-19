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
// chain validation (so a successful retry still resolves even after the proposal was
// retracted or the probe drifted). Only a first ack runs the full-chain gate. A per-target
// advisory lock (hashtextextended on the result id, mirroring answerProbe) serializes the
// first-write race so two "知道了" clicks can never both insert.

import {
  isCandidateError,
  validateAckableOutcome,
} from '@/capabilities/shell/server/teaching-brief';
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
  return {
    brief_acknowledgement_event_id: existing.id,
    probe_result_event_id: probeResultEventId,
    brief_id: typeof briefId === 'string' ? briefId : '',
    idempotent: true,
  };
}

/**
 * Acknowledge a delivered teaching-brief outcome. Appends exactly one
 * `experimental:brief_acknowledged` event keyed on the probe_result event, or
 * short-circuits to the existing ack when one is already recorded.
 *
 * Idempotency wins over the chain gate: an already-recorded ack returns idempotent:true
 * BEFORE any validation, so a retry after a lost response succeeds even if the proposal
 * was since retracted or the probe drifted (round-3, codex P2). Only a FIRST ack is
 * fail-closed on a bad target: the id MUST resolve to a delivered, ackable outcome —
 * a canonical result whose full chain is intact (existing canonical mind-probe + accepted
 * conjecture proposal). 404 when the result is absent, 409 when the chain is corrupt or
 * orphaned (illegal resolution/outcome pair, provenance mismatch, missing probe, or
 * non-accepted proposal). This reuses the reader's `validateAckableOutcome` gate so a
 * result the brief would never display can never be acked. We only READ provenance, never
 * write derived status back onto proposal/question/result (contract §4.2).
 */
export async function acknowledgeTeachingBriefOutcome(
  db: Db,
  probeResultEventId: string,
  now: Date = new Date(),
): Promise<AcknowledgeBriefResult> {
  // Idempotent short-circuit FIRST, before any chain validation: an already-recorded ack
  // is immutable + append-only, so returning it is always correct regardless of whether
  // the outcome's chain is still valid now. Re-gating a successful retry through
  // validateAckableOutcome would 409 and surface a completed ack as a failure (round-3,
  // codex P2). Safe without the lock; the lock below closes the first-write race.
  const prior = await findExistingAck(db, probeResultEventId);
  if (prior) return prior;

  // First ack — the target must be a delivered, ackable outcome. Load the result (404 if
  // absent), then run the full-chain gate (single source of truth with the reader):
  // canonical result + existing canonical mind-probe + accepted conjecture proposal.
  // Read-only, so it runs before the append transaction; any break fails closed with 409.
  const [result] = await db
    .select({
      id: event.id,
      action: event.action,
      subject_kind: event.subject_kind,
      subject_id: event.subject_id,
      caused_by_event_id: event.caused_by_event_id,
      payload: event.payload,
    })
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
  const outcome = await validateAckableOutcome(db, result, now);
  if (isCandidateError(outcome)) {
    throw new ApiError(
      'not_an_ackable_outcome',
      `event ${probeResultEventId} is not an ackable outcome (${outcome.reason})`,
      409,
    );
  }
  const briefId = outcome.value.conjectureEventId;

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
