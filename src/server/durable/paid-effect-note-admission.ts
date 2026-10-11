// YUK-1355 Lane B — note_verify atomic backend-control admission builder
// (P1-R2-2). Kept in its own module (not inside paid-effect-control.ts, whose
// probe registry imports the obligation projection) so the import graph stays
// acyclic: this file imports control + protocol; nothing imports it back
// except the note consumers.
//
// The hook this builds is passed as reserveNoteVerification's optional
// controlAdmission: it runs INSIDE the reservation transaction, takes the
// shared family control lock FIRST, and verifies backend owner/generation
// against the same lock window the switch serializes on. A fenced delivery
// throws PaidEffectControlFencedError → the reservation rolls back (no claim
// row, no send). Every production note_verify send entry (retained pg-boss
// handler, DBOS family adapter) wires this by default; legacy direct callers
// of runNoteVerify/reserveNoteVerification without the hook keep the old
// behavior and must not be introduced for send paths.
import type { Tx } from '@/db/client';
import {
  admitPaidEffectDeliveryControl,
  isPaidEffectControlUndefinedTable,
  lockPaidEffectControlFamily,
} from './paid-effect-control';
import { NOTE_VERIFY_OBLIGATION_FAMILY } from './paid-effect-note-obligations';
import type { PaidEffectDeliveryRef } from './paid-effect-protocol';
import { PaidEffectControlFencedError } from './paid-effect-protocol';

export type { PaidEffectDeliveryRef };

/**
 * Build the in-transaction admission hook for one delivery. The ref carries
 * the dispatch identity: pg-boss jobs pass {backend:'pg-boss', deliveryId:
 * jobId}; a DBOS host passes {backend:'dbos', deliveryId: workflowId,
 * generation} — generation is REQUIRED for DBOS under an explicit control row.
 * A missing paid_effect_control TABLE (parent migration not yet applied) is
 * the documented bootstrap default: pg-boss stands, DBOS stays fenced —
 * exactly the outside-of-tx semantics, now inside the reservation window.
 */
export function buildNoteVerificationControlAdmission(
  ref: PaidEffectDeliveryRef,
): (tx: Tx) => Promise<void> {
  return async (tx: Tx) => {
    await lockPaidEffectControlFamily(tx, NOTE_VERIFY_OBLIGATION_FAMILY);
    let admission;
    try {
      admission = await admitPaidEffectDeliveryControl(tx, NOTE_VERIFY_OBLIGATION_FAMILY, ref);
    } catch (error) {
      if (isPaidEffectControlUndefinedTable(error)) return; // bootstrap default
      throw error;
    }
    if (admission.kind === 'fenced') {
      throw new PaidEffectControlFencedError(
        NOTE_VERIFY_OBLIGATION_FAMILY,
        admission.reason,
        admission.owner,
      );
    }
  };
}
