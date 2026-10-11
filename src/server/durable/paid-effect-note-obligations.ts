// YUK-1355 Lane B (P1-3) — note-family obligation adapter for the paid-effect
// backend-control switch gate. note_verify never writes paid_effect rows (its
// note_verification_claim stays the paid authority), so a switch that scanned
// only paid_effect could not see the family's unfinished obligations and would
// silently move ownership over in-flight/ambiguous/staged verifications. This
// adapter maps the LIVE claim states onto the shared blocking vocabulary so
// switchPaidEffectBackend refuses until the family is drained:
//
//   reserved | provider_started            → 'sending'  (a delivery owns the
//                                                claim; the provider boundary
//                                                may be crossed or imminent)
//   ambiguous                              → 'unknown'  (paid outcome unknown)
//   retry_wait                             → 'pending'  (released for a later
//                                                attempt — a future send)
//   result_ready                           → 'receipt_ready' (outcome known,
//                                                application unfinished)
//   completed | attempts_exhausted (and no
//   claim row at all)                      → not blocking
//
// Read-only: this adapter never mutates claim rows and never duplicates the
// claim state machine — it only projects it for the switch decision.
import { count, eq, inArray } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { note_verification_claim } from '@/db/schema';

/** Mirrors NOTE_VERIFY_PAID_EFFECT_FAMILY (jobs) / NOTE_VERIFY_FAMILY (DBOS
 * adapter); an offline test pins all three literals equal. */
export const NOTE_VERIFY_OBLIGATION_FAMILY = 'note_verify';

export interface NoteVerifyObligationCounts {
  readonly pending: number;
  readonly sending: number;
  readonly unknown: number;
  readonly receipt_ready: number;
}

export async function countNoteVerifyClaimObligations(
  db: Db | Tx,
): Promise<NoteVerifyObligationCounts> {
  const rows = await db
    .select({ state: note_verification_claim.state, n: count() })
    .from(note_verification_claim)
    .where(
      inArray(note_verification_claim.state, [
        'retry_wait',
        'reserved',
        'provider_started',
        'ambiguous',
        'result_ready',
      ]),
    )
    .groupBy(note_verification_claim.state);
  let pending = 0;
  let sending = 0;
  let unknown = 0;
  let receiptReady = 0;
  for (const row of rows) {
    const n = Number(row.n);
    switch (row.state) {
      case 'retry_wait':
        pending += n;
        break;
      case 'reserved':
      case 'provider_started':
        sending += n;
        break;
      case 'ambiguous':
        unknown += n;
        break;
      case 'result_ready':
        receiptReady += n;
        break;
      default:
        break;
    }
  }
  return { pending, sending, unknown, receipt_ready: receiptReady };
}

/** Single-claim probe used by tests/tooling: the unfinished obligation states. */
export const NOTE_VERIFY_OBLIGATION_CLAIM_STATES = [
  'retry_wait',
  'reserved',
  'provider_started',
  'ambiguous',
  'result_ready',
] as const;

export async function hasNoteVerifyClaimInState(
  db: Db,
  state: (typeof NOTE_VERIFY_OBLIGATION_CLAIM_STATES)[number],
): Promise<boolean> {
  const rows = await db
    .select({ artifactId: note_verification_claim.artifact_id })
    .from(note_verification_claim)
    .where(eq(note_verification_claim.state, state))
    .limit(1);
  return rows.length > 0;
}
