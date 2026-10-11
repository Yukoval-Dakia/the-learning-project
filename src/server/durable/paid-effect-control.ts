// YUK-1355 Lane B — paid-effect backend control: symmetric pg-boss/DBOS
// ownership admission with generation fencing, plus the switch gate.
//
// - Absence of a control row is the bootstrap DEFAULT OWNER (pg-boss,
//   generation 0, explicit:false). DBOS never default-admits; it requires an
//   explicit control row created by the parent-controlled switch.
// - Admission takes the control row FOR SHARE inside the caller's transaction,
//   so it serializes against a concurrent switch (which takes FOR UPDATE).
// - switchPaidEffectBackend refuses while the family has effects in
//   'sending'/'unknown' (in-flight or unresolved paid sends); v1 has no
//   draining phases — the blocked switch subsumes them. Producer-side dispatch
//   cutover stays parent-owned.
// - Before the parent's migration lands, paid_effect_control may not exist;
//   isPaidEffectControlUndefinedTable() lets consumers treat that explicitly
//   (pg-boss default stands; DBOS stays fenced) instead of guessing.
import { and, count, eq, inArray } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { paid_effect, paid_effect_control } from '@/db/schema';
import {
  DEFAULT_PAID_EFFECT_BACKEND,
  DEFAULT_PAID_EFFECT_GENERATION,
  PAID_EFFECT_BACKEND_SCHEMA,
  PAID_EFFECT_SWITCH_BLOCKING_STATES,
  type PaidEffectBackend,
  type PaidEffectControlAdmission,
  type PaidEffectControlSnapshot,
  type PaidEffectDeliveryRef,
  type PaidEffectState,
  PaidEffectSwitchBlockedError,
  decidePaidEffectControlAdmission,
  summarizePaidEffectSwitchBlocking,
} from './paid-effect-protocol';

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
 * Switch the family's owning backend. Blocked while any effect of the family
 * is 'sending' or 'unknown' (in-flight / unresolved paid sends). On success the
 * generation increments, which fences stale deliveries dispatched by the
 * previous owner — including an A→B→A round trip. Switching to the current
 * owner is an idempotent no-op that does not bump the generation.
 */
export async function switchPaidEffectBackend(
  db: Db,
  family: string,
  to: PaidEffectBackend,
): Promise<PaidEffectControlSnapshot> {
  return db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(paid_effect_control)
      .where(eq(paid_effect_control.family, family))
      .for('update');
    let row = existing[0];
    if (!row) {
      // Materialize the default owner first so the switch bumps a real row.
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
      if (!row) throw new PaidEffectSwitchBlockedError(family, { sending: 0, unknown: 0 });
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

/**
 * True only when the failure is paid_effect_control not existing yet (PG
 * 42P01, or the relation named in the message). Valid ONLY around code whose
 * sole query touches paid_effect_control — both shipped call sites (note
 * verify pg-boss admission, DBOS family admission) satisfy that; nothing else
 * may be swallowed.
 */
export function isPaidEffectControlUndefinedTable(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === '42P01') return true;
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('paid_effect_control') && message.includes('does not exist');
}
