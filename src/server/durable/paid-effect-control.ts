// Backend-switch composition. Generic ownership admission and generation fencing
// live in src/db/paid-effect-control.ts.
//
// A missing control row is the bootstrap owner (pg-boss, generation 0); DBOS
// requires an explicit row. Admission takes the row FOR SHARE in the caller's
// transaction, so it serializes against a switch's FOR UPDATE.
//
// A switch is refused while any obligation is unfinished, including note_verify
// claims projected through a pinned probe. Until per-state takeover evidence
// exists, ownership moves only over a fully drained family; producer cutover
// stays parent-owned.
//
// The table may not exist before the control migration. Probe with
// paidEffectControlTableExists(); catching 42P01 would abort the transaction and
// every later statement fails with 25P02.
import { and, count, eq, inArray } from 'drizzle-orm';

import {
  NOTE_VERIFY_OBLIGATION_FAMILY,
  countNoteVerifyClaimObligations,
} from '@/capabilities/notes/public';
import {
  DEFAULT_PAID_EFFECT_BACKEND,
  DEFAULT_PAID_EFFECT_GENERATION,
  PAID_EFFECT_SWITCH_BLOCKING_STATES,
  PAID_EFFECT_SWITCH_UNSUPPORTED_FAMILIES,
  type PaidEffectBackend,
  type PaidEffectControlSnapshot,
  type PaidEffectState,
  PaidEffectSwitchBlockedError,
  PaidEffectSwitchUnsupportedError,
  summarizePaidEffectSwitchBlocking,
} from '@/core/migration/paid-effect-protocol';
import type { Db, Tx } from '@/db/client';
import { lockPaidEffectControlFamily, rowToControl } from '@/db/paid-effect-control';
import { paid_effect, paid_effect_control } from '@/db/schema';

/**
 * Live unfinished obligations for families whose paid authority is not a
 * paid_effect row. Runs on the caller's transaction so it sees exactly the state
 * the switch serialized against.
 */
const FAMILY_OBLIGATION_PROBES: ReadonlyMap<
  string,
  (tx: Tx) => Promise<{
    pending: number;
    sending: number;
    unknown: number;
    receipt_ready: number;
  }>
> = new Map([[NOTE_VERIFY_OBLIGATION_FAMILY, countNoteVerifyClaimObligations]]);

/**
 * Switch the family's backend. Refused while any obligation is unfinished. The
 * generation bump fences stale deliveries from the previous owner, including an
 * A→B→A round trip. Switching to the current owner is a no-op.
 */
export async function switchPaidEffectBackend(
  db: Db,
  family: string,
  to: PaidEffectBackend,
): Promise<PaidEffectControlSnapshot> {
  return db.transaction(async (tx) => {
    // Family lock closes the missing-row race with an admission that read the
    // default owner while a concurrent switch never saw its uncommitted claim.
    await lockPaidEffectControlFamily(tx, family);
    const existing = await tx
      .select()
      .from(paid_effect_control)
      .where(eq(paid_effect_control.family, family))
      .for('update');
    let row = existing[0];
    if (!row) {
      // Materialize the default row so the switch bumps a real row. ON CONFLICT
      // plus re-lock serializes concurrent switches: one inserts, the other locks.
      const inserted = await tx
        .insert(paid_effect_control)
        .values({
          family,
          backend: DEFAULT_PAID_EFFECT_BACKEND,
          generation: DEFAULT_PAID_EFFECT_GENERATION,
        })
        .onConflictDoNothing({ target: paid_effect_control.family })
        .returning();
      row =
        inserted[0] ??
        (
          await tx
            .select()
            .from(paid_effect_control)
            .where(eq(paid_effect_control.family, family))
            .for('update')
        )[0];
      if (!row) throw new PaidEffectSwitchBlockedError(family, blockedShape());
    }
    const grouped = await tx
      .select({ state: paid_effect.state, n: count() })
      .from(paid_effect)
      .where(
        and(
          eq(paid_effect.family, family),
          inArray(paid_effect.state, [...PAID_EFFECT_SWITCH_BLOCKING_STATES]),
        ),
      )
      .groupBy(paid_effect.state);
    const countsByState: Partial<Record<PaidEffectState, number>> = {};
    for (const group of grouped) countsByState[group.state] = Number(group.n);
    const probe = FAMILY_OBLIGATION_PROBES.get(family);
    if (probe) {
      // Same transaction and lock window, never a second connection's snapshot.
      const projected = await probe(tx);
      countsByState.pending = (countsByState.pending ?? 0) + projected.pending;
      countsByState.sending = (countsByState.sending ?? 0) + projected.sending;
      countsByState.unknown = (countsByState.unknown ?? 0) + projected.unknown;
      countsByState.receipt_ready = (countsByState.receipt_ready ?? 0) + projected.receipt_ready;
    }
    const gate = summarizePaidEffectSwitchBlocking(countsByState);
    if (gate.blocked) throw new PaidEffectSwitchBlockedError(family, gate.blocking);
    const current = rowToControl(family, row);
    if (current.backend === to) return current;
    if (PAID_EFFECT_SWITCH_UNSUPPORTED_FAMILIES.includes(family)) {
      throw new PaidEffectSwitchUnsupportedError(family);
    }
    const generation = current.generation + 1;
    await tx
      .update(paid_effect_control)
      .set({ backend: to, generation, updated_at: new Date() })
      .where(eq(paid_effect_control.family, family));
    return { family, backend: to, generation, explicit: true } as const;
  });
}

function blockedShape(): {
  pending: number;
  sending: number;
  unknown: number;
  receipt_ready: number;
} {
  return { pending: 0, sending: 0, unknown: 0, receipt_ready: 0 };
}
