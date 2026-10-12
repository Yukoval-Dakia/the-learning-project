// Shared PG backend-control admission. The server switch composes family probes.
import { eq, sql } from 'drizzle-orm';

import {
  DEFAULT_PAID_EFFECT_BACKEND,
  DEFAULT_PAID_EFFECT_GENERATION,
  PAID_EFFECT_BACKEND_SCHEMA,
  type PaidEffectControlAdmission,
  type PaidEffectControlSnapshot,
  type PaidEffectDeliveryRef,
  decidePaidEffectControlAdmission,
  paidEffectControlLockKey,
} from '@/core/migration/paid-effect-protocol';
import type { Db, Tx } from '@/db/client';
import { paid_effect_control } from '@/db/schema';

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

function defaultControl(family: string): PaidEffectControlSnapshot {
  return {
    family,
    backend: DEFAULT_PAID_EFFECT_BACKEND,
    generation: DEFAULT_PAID_EFFECT_GENERATION,
    explicit: false,
  };
}

export function rowToControl(
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
