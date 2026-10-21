// Notes owns the note_verify admission hook. The shared PG admission takes the
// family control lock first, inside the reservation transaction, so a fenced
// delivery rolls the reservation back before any claim or provider work.
//
// Before the control table exists, to_regclass (non-aborting) keeps pg-boss as
// the bootstrap owner; a caught 42P01 would abort the live transaction.

import {
  PaidEffectControlFencedError,
  type PaidEffectDeliveryRef,
  decidePaidEffectControlAdmission,
} from '@/core/migration/paid-effect-protocol';
import type { Tx } from '@/db/client';
import {
  admitPaidEffectDeliveryControl,
  lockPaidEffectControlFamily,
  paidEffectControlTableExists,
} from '@/db/paid-effect-control';
import { NOTE_VERIFY_OBLIGATION_FAMILY } from './paid-effect-note-obligations';

export type { PaidEffectDeliveryRef };

/**
 * Build the admission hook for one delivery. After bootstrap both backends
 * require the generation persisted at dispatch; the retained handler passes none,
 * so cutover stays guarded.
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
