// YUK-1355 Lane B — paid-effect backend control: symmetric pg-boss/DBOS
// ownership admission with generation fencing, plus the switch gate.
//
// - Absence of a control row is the bootstrap DEFAULT OWNER (pg-boss,
//   generation 0, explicit:false). DBOS never default-admits; it requires an
//   explicit control row created by the parent-controlled switch.
// - Admission takes the control row FOR SHARE inside the caller's transaction,
//   so it serializes against a concurrent switch (which takes FOR UPDATE).
// - switchPaidEffectBackend refuses while the family has ANY unfinished
//   obligation (P1-5: pending/sending/unknown/receipt_ready — intents and
//   unapplied receipts included); for families whose paid authority lives
//   outside paid_effect (note_verify), a pinned adapter projects their live
//   claim states into the same blocking vocabulary (P1-3). Until the parent
//   defines per-state takeover evidence, ownership moves only over a fully
//   drained family. Producer-side dispatch cutover stays parent-owned.
// - Before the parent's migration lands, paid_effect_control may not exist;
//   paidEffectControlTableExists() is the NON-ABORTING probe for that (a
//   caught 42P01 would abort a live transaction — every later statement
//   fails with 25P02 — so in-transaction code must never catch-and-continue
//   it).
import { and, count, eq, inArray, sql } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { paid_effect, paid_effect_control } from '@/db/schema';
import {
  NOTE_VERIFY_OBLIGATION_FAMILY,
  countNoteVerifyClaimObligations,
} from './paid-effect-note-obligations';
import {
  DEFAULT_PAID_EFFECT_BACKEND,
  DEFAULT_PAID_EFFECT_GENERATION,
  PAID_EFFECT_BACKEND_SCHEMA,
  PAID_EFFECT_SWITCH_BLOCKING_STATES,
  PAID_EFFECT_SWITCH_UNSUPPORTED_FAMILIES,
  type PaidEffectBackend,
  type PaidEffectControlAdmission,
  type PaidEffectControlSnapshot,
  type PaidEffectDeliveryRef,
  type PaidEffectState,
  PaidEffectSwitchBlockedError,
  PaidEffectSwitchUnsupportedError,
  decidePaidEffectControlAdmission,
  paidEffectControlLockKey,
  summarizePaidEffectSwitchBlocking,
} from './paid-effect-protocol';

/**
 * THE family-level serialization lock (P1-R2-1): every control admission and
 * every switch takes it FIRST, in the SAME transaction, BEFORE reading or
 * materializing the control row — a row lock serializes nothing while the
 * row does not exist, which is exactly the missing-row race. Postgres
 * advisory xact locks are reentrant per transaction, so nesting
 * admit-inside-claim is a no-op re-acquire.
 */
export async function lockPaidEffectControlFamily(tx: Tx, family: string): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${paidEffectControlLockKey(family)}, 0))`,
  );
}

/**
 * Pinned family obligation probes: families whose paid authority is NOT a
 * paid_effect row project their live unfinished obligations here. The probe
 * ALWAYS runs on the caller's transaction (never a separate connection /
 * snapshot) so it observes exactly the state the switch serialized against.
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

function defaultControl(family: string): PaidEffectControlSnapshot {
  return {
    family,
    backend: DEFAULT_PAID_EFFECT_BACKEND,
    generation: DEFAULT_PAID_EFFECT_GENERATION,
    explicit: false,
  };
}

function rowToControl(
  family: string,
  row: typeof paid_effect_control.$inferSelect,
): PaidEffectControlSnapshot {
  return {
    family,
    backend: PAID_EFFECT_BACKEND_SCHEMA.parse(row.backend),
    generation: row.generation,
    explicit: true,
  };
}

/** Control snapshot for a family; an absent row is the bootstrap default owner. */
export async function readPaidEffectControl(
  db: Db | Tx,
  family: string,
): Promise<PaidEffectControlSnapshot> {
  const rows = await db
    .select()
    .from(paid_effect_control)
    .where(eq(paid_effect_control.family, family))
    .limit(1);
  const row = rows[0];
  return row ? rowToControl(family, row) : defaultControl(family);
}

/**
 * Admit one delivery under backend control. Runs in the caller's transaction
 * with a FOR SHARE lock on the control row; the decision itself is the pure
 * protocol function, so pg-boss and DBOS get byte-identical rules.
 */
export async function admitPaidEffectDeliveryControl(
  tx: Tx,
  family: string,
  ref: PaidEffectDeliveryRef,
): Promise<PaidEffectControlAdmission> {
  // FIRST: the family serialization lock, BEFORE reading the control row —
  // with no row present a FOR SHARE would lock nothing and a concurrent
  // switch (insert + scan + flip) could commit unseen between this read and
  // the caller's claim.
  await lockPaidEffectControlFamily(tx, family);
  const rows = await tx
    .select()
    .from(paid_effect_control)
    .where(eq(paid_effect_control.family, family))
    .for('share');
  const row = rows[0];
  const control = row ? rowToControl(family, row) : defaultControl(family);
  return decidePaidEffectControlAdmission(control, ref);
}

/**
 * Switch the family's owning backend. Blocked while ANY unfinished obligation
 * exists for the family (P1-5): paid_effect rows in pending/sending/unknown/
 * receipt_ready PLUS the pinned family probe's projection for families whose
 * paid authority lives elsewhere (note_verify claim states, P1-3). On success
 * the generation increments, which fences stale deliveries dispatched by the
 * previous owner — including an A→B→A round trip. Switching to the current
 * owner is an idempotent no-op that does not bump the generation.
 */
export async function switchPaidEffectBackend(
  db: Db,
  family: string,
  to: PaidEffectBackend,
): Promise<PaidEffectControlSnapshot> {
  return db.transaction(async (tx) => {
    // FIRST: the family serialization lock — closes the missing-row race
    // where an admission reading "no row = default pg-boss" overlapped a
    // concurrent insert+scan+flip switch that never saw the uncommitted claim.
    await lockPaidEffectControlFamily(tx, family);
    if (PAID_EFFECT_SWITCH_UNSUPPORTED_FAMILIES.includes(family)) {
      throw new PaidEffectSwitchUnsupportedError(family);
    }
    const existing = await tx
      .select()
      .from(paid_effect_control)
      .where(eq(paid_effect_control.family, family))
      .for('update');
    let row = existing[0];
    if (!row) {
      // Materialize the default owner first so the switch bumps a real row.
      // ON CONFLICT DO NOTHING + re-lock closes the concurrent-switch insert
      // race (P1-2): exactly one switch materializes, the other re-locks it.
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
      // Same transaction, same lock window — never a second connection's
      // snapshot (P1-R2).
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

/**
 * Non-aborting existence probe for paid_effect_control, safe to run INSIDE a
 * live transaction (to_regclass returns NULL instead of raising 42P01).
 * In-transaction bootstrap paths must use this, never try/catch around SQL
 * that aborts the transaction.
 */
export async function paidEffectControlTableExists(tx: Tx): Promise<boolean> {
  const rows = await tx.execute<{ reg: string | null }>(
    sql`select to_regclass('paid_effect_control') as reg`,
  );
  return rows.length > 0 && rows[0].reg != null;
}
