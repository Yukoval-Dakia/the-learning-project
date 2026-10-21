// Projects the live claim states onto the backend-control switch vocabulary.
// note_verify never writes paid_effect rows, so scanning only paid_effect would
// miss this family's unfinished work and let a switch move ownership over it.
// Read-only; it never mutates claims.
//
//   reserved | provider_started → sending
//   ambiguous                   → unknown
//   retry_wait                  → pending
//   result_ready                → receipt_ready
//   completed | attempts_exhausted | no claim → not blocking
import { count, eq, inArray } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { note_verification_claim } from '@/db/schema';

/** Keep in sync with the pg-boss handler and DBOS adapter literals. */
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

/** Single-state probe used by tests and tooling. */
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
