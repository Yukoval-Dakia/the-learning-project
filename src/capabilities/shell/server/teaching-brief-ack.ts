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
// subject_id=<result id>)`. A per-target advisory lock (hashtextextended on the result
// id, mirroring answerProbe) serializes concurrent acks so the check-existing + append
// is atomic: two racing "知道了" clicks can never both insert. A prior ack short-circuits
// and is reported with idempotent:true (the first ack wins, append-only).

import {
  isCandidateError,
  validateAckableOutcome,
} from '@/capabilities/shell/server/teaching-brief';
import { newId } from '@/core/ids';
import { BRIEF_ACK_ACTION } from '@/core/schema/conjecture';
import type { Db } from '@/db/client';
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
 * Acknowledge a delivered teaching-brief outcome. Appends exactly one
 * `experimental:brief_acknowledged` event keyed on the probe_result event, or
 * short-circuits to the existing ack when one is already recorded.
 *
 * Fail-closed on a bad target: the id MUST resolve to a delivered, ACKABLE outcome —
 * a canonical result event whose full chain is intact (existing canonical mind-probe +
 * accepted conjecture proposal). 404 when the result is absent, 409 when the chain is
 * corrupt or orphaned (illegal resolution/outcome pair, provenance mismatch, missing
 * probe, or non-accepted proposal). This reuses the reader's `validateAckableOutcome`
 * gate so a result the brief would never display can never be acked. We only READ the
 * result's provenance (`conjecture_event_id`), never write derived status (contract §4.2).
 */
export async function acknowledgeTeachingBriefOutcome(
  db: Db,
  probeResultEventId: string,
  now: Date = new Date(),
): Promise<AcknowledgeBriefResult> {
  // Load the target result event (404 if absent), then run the FULL ackable-outcome chain
  // gate (single source of truth with the reader): canonical result + existing canonical
  // mind-probe + accepted conjecture proposal. This is read-only, so it runs BEFORE the
  // append transaction; any break fails closed with 409 and writes nothing
  // (YUK-708 review round-2, codex P2). The advisory lock below is only needed to make the
  // check-existing + append atomic, not this validation.
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

  return db.transaction(async (tx) => {
    // Serialize concurrent acks on the SAME outcome so check-existing + append is
    // atomic (per-target key via hashtextextended — different outcomes don't contend).
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${probeResultEventId}, 0))`);

    // One effective ack per outcome: a prior ack short-circuits — NO second event
    // (append-only, first ack wins). The advisory lock above makes this atomic.
    const [existing] = await tx
      .select({ id: event.id })
      .from(event)
      .where(
        and(
          eq(event.action, BRIEF_ACK_ACTION),
          eq(event.subject_kind, 'event'),
          eq(event.subject_id, probeResultEventId),
        ),
      )
      .limit(1);
    if (existing) {
      return {
        brief_acknowledgement_event_id: existing.id,
        probe_result_event_id: probeResultEventId,
        brief_id: briefId,
        idempotent: true,
      };
    }

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
