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
//
// Missing paid_effect_control TABLE (parent migration not yet applied) is
// handled with to_regclass — a NON-ABORTING probe, because after 42P01 the
// reservation transaction would be aborted and every later statement would
// fail with 25P02. Missing table ⇒ pg-boss stands as the bootstrap default
// owner and is admitted; DBOS is hard-fenced. Never catch-and-continue a
// 42P01 inside a live transaction.
import type { Tx } from '@/db/client';
import {
  admitPaidEffectDeliveryControl,
  lockPaidEffectControlFamily,
  paidEffectControlTableExists,
} from './paid-effect-control';
import { NOTE_VERIFY_OBLIGATION_FAMILY } from './paid-effect-note-obligations';
import {
  PaidEffectControlFencedError,
  type PaidEffectDeliveryRef,
  decidePaidEffectControlAdmission,
} from './paid-effect-protocol';

export type { PaidEffectDeliveryRef };

/**
 * Build the in-transaction admission hook for one delivery. The ref carries
 * the dispatch identity: pg-boss jobs pass {backend:'pg-boss', deliveryId:
 * jobId}; a DBOS host passes {backend:'dbos', deliveryId: workflowId,
 * generation}. After bootstrap, BOTH backends require the generation persisted
 * at dispatch. Versioned hosts can validate paidEffectDispatchRefSchema first.
 * The retained handler currently passes no generation; cutover stays guarded.
 */
export function buildNoteVerificationControlAdmission(
  ref: PaidEffectDeliveryRef,
): (tx: Tx) => Promise<void> {
  return async (tx: Tx) => {
    await lockPaidEffectControlFamily(tx, NOTE_VERIFY_OBLIGATION_FAMILY);
    const admission = (await paidEffectControlTableExists(tx))
      ? await admitPaidEffectDeliveryControl(tx, NOTE_VERIFY_OBLIGATION_FAMILY, ref)
      : decidePaidEffectControlAdmission(
          {
            family: NOTE_VERIFY_OBLIGATION_FAMILY,
            backend: 'pg-boss',
            generation: 0,
            explicit: false,
          },
          ref,
        );
    if (admission.kind === 'fenced') {
      throw new PaidEffectControlFencedError(
        NOTE_VERIFY_OBLIGATION_FAMILY,
        admission.reason,
        admission.owner,
      );
    }
  };
}
