// YUK-1355 Lane B — paid-effect store: the transactional state transitions for
// the shared protocol. Every transition runs inside the CALLER's transaction
// and takes the identity row lock (SELECT … FOR UPDATE); the composite primary
// key IS the effect identity, so cross-backend races serialize on the row —
// that lock is the CAS. This module never opens transactions for effect
// transitions (reserve/sweep/switch are the documented exceptions) and never
// touches identity columns with UPDATE.
//
// Pinned semantics (docs/planning/2026-10-11-yuk1355-paid-effect-protocol.md):
// - intent before physical send; ONE send admission (reservePaidEffect /
//   claimPaidEffectSend) with the winner/held/completed discrimination;
// - immutable result receipt (semantic JSON equality; unequal rewrite
//   rejected), completable only by the winning delivery (+fence when given);
// - unknown outcomes are durable unresolved obligations, never auto-replayed,
//   including under a new tick or a new revision/workset of the same entity —
//   enforced by the entity gate, whose scope ('entity' | 'entity-revision')
//   is a pinned family-level protocol option;
// - failed application leaves the row in receipt_ready (readable unfinished
//   obligation) and the only way forward is replaying the application from the
//   receipt — there is no path back to a physical send.
import { type SQL, and, eq, inArray, lt, ne, or, sql } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { paid_effect } from '@/db/schema';
import { admitPaidEffectDeliveryControl } from './paid-effect-control';
import {
  PAID_EFFECT_BACKEND_SCHEMA,
  PAID_EFFECT_ENTITY_GATE_STATES,
  PAID_EFFECT_STATE_SCHEMA,
  PaidEffectApplicationConflictError,
  type PaidEffectBackend,
  PaidEffectControlFencedError,
  PaidEffectDeliveryConflictError,
  type PaidEffectIdentity,
  PaidEffectIdentityConflictError,
  type PaidEffectInput,
  PaidEffectProtocolError,
  PaidEffectReceiptConflictError,
  type PaidEffectReservation,
  type PaidEffectState,
  canonicalizePaidEffectJson,
  computePaidEffectIdentity,
  paidEffectGateLockKey,
  paidEffectIdentitySchema,
  paidEffectJsonEquals,
} from './paid-effect-protocol';

type PaidEffectRow = typeof paid_effect.$inferSelect;

export interface PaidEffectSnapshot {
  readonly identity: PaidEffectIdentity;
  readonly state: PaidEffectState;
  readonly fence: number;
  readonly delivery: {
    readonly backend: PaidEffectBackend | null;
    readonly deliveryId: string | null;
    readonly tickId: string | null;
  };
  readonly sendLeaseExpiresAt: Date | null;
  readonly result: unknown;
  readonly resultRecordedAt: Date | null;
  readonly application: unknown;
  readonly appliedAt: Date | null;
  readonly applicationAttempts: number;
  readonly lastApplicationError: string | null;
  readonly unresolvedReason: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Read-side obligation view: readable regardless of any workflow's status. */
export type PaidEffectObligationView = PaidEffectSnapshot;

export type PaidEffectIntentAdmission =
  | { readonly kind: 'admitted' }
  | { readonly kind: 'existing'; readonly state: PaidEffectState };

export interface PaidEffectSendClaimDelivery {
  readonly backend: PaidEffectBackend;
  readonly deliveryId: string;
  readonly tickId?: string | null;
  readonly leaseExpiresAt: Date;
  /** Dispatch-time control generation; REQUIRED for DBOS deliveries. */
  readonly generation?: number | null;
}

export type PaidEffectSendClaim =
  | { readonly kind: 'claimed'; readonly fence: number }
  | { readonly kind: 'missing' }
  | {
      readonly kind: 'refused';
      readonly state: PaidEffectState;
      /** true when a receipt exists and the caller should replay application, not send. */
      readonly receiptKnown: boolean;
      /** names the open effect whose entity gate blocked this claim, when applicable */
      readonly blockedBy?: PaidEffectIdentity | null;
    };

function identityWhere(identity: PaidEffectIdentity): SQL | undefined {
  return and(
    eq(paid_effect.family, identity.family),
    eq(paid_effect.entity_id, identity.entityId),
    eq(paid_effect.entity_revision, identity.entityRevision),
    eq(paid_effect.unit, identity.unit),
    eq(paid_effect.input_digest, identity.inputDigest),
  );
}

function toSnapshot(row: PaidEffectRow): PaidEffectSnapshot {
  const state = PAID_EFFECT_STATE_SCHEMA.parse(row.state);
  const backend = row.delivery_backend
    ? PAID_EFFECT_BACKEND_SCHEMA.parse(row.delivery_backend)
    : null;
  return {
    identity: paidEffectIdentitySchema.parse({
      family: row.family,
      entityId: row.entity_id,
      entityRevision: row.entity_revision,
      unit: row.unit,
      inputDigest: row.input_digest,
    }),
    state,
    fence: row.fence,
    delivery: {
      backend,
      deliveryId: row.delivery_id,
      tickId: row.delivery_tick,
    },
    sendLeaseExpiresAt: row.send_lease_expires_at,
    result: row.result_json,
    resultRecordedAt: row.result_recorded_at,
    application: row.application_json,
    appliedAt: row.applied_at,
    applicationAttempts: row.application_attempts,
    lastApplicationError: row.last_application_error,
    unresolvedReason: row.unresolved_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function lockRow(tx: Tx, identity: PaidEffectIdentity): Promise<PaidEffectRow | null> {
  const rows = await tx.select().from(paid_effect).where(identityWhere(identity)).for('update');
  return rows[0] ?? null;
}

/**
 * Serialize send admissions per gate scope: the advisory xact lock closes the
 * check-then-act window where two concurrent reserves for DIFFERENT identities
 * covered by one scope could both pass the gate scan and both send. Mirrors
 * the repo's established hashtextextended advisory-lock pattern
 * (producer-fence-lock.ts, session-orphan-family.ts).
 */
async function lockEntityGate(tx: Tx, identity: PaidEffectIdentity): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${paidEffectGateLockKey(identity)}, 0))`,
  );
}

/**
 * Gate scan under the FIXED predicate (paidEffectGateBlocks): an open
 * sending/unknown effect of the same (family, entityId) blocks this claim
 * UNLESS it is a sibling unit of the SAME revision. Same revision + same unit
 * + different digest BLOCKS (reconciliation); a different revision BLOCKS
 * (entity-level cross-revision/cross-night). Runs inside the caller's
 * transaction AFTER lockEntityGate; returns the blocker's identity, or null.
 */
async function findGateBlocker(
  tx: Tx,
  identity: PaidEffectIdentity,
): Promise<PaidEffectIdentity | null> {
  const blockers = await tx
    .select({
      family: paid_effect.family,
      entity_id: paid_effect.entity_id,
      entity_revision: paid_effect.entity_revision,
      unit: paid_effect.unit,
      input_digest: paid_effect.input_digest,
    })
    .from(paid_effect)
    .where(
      and(
        eq(paid_effect.family, identity.family),
        eq(paid_effect.entity_id, identity.entityId),
        inArray(paid_effect.state, [...PAID_EFFECT_ENTITY_GATE_STATES]),
        or(
          ne(paid_effect.entity_revision, identity.entityRevision),
          ne(paid_effect.unit, identity.unit),
          ne(paid_effect.input_digest, identity.inputDigest),
        ),
        // FIXED gate predicate — mirrors paidEffectGateBlocks exactly:
        // blocked unless (same revision AND different unit).
        sql`not (
          ${paid_effect.entity_revision} = ${identity.entityRevision}
          and ${paid_effect.unit} <> ${identity.unit}
        )`,
      ),
    )
    .limit(1);
  const blocker = blockers[0];
  if (!blocker) return null;
  return paidEffectIdentitySchema.parse({
    family: blocker.family,
    entityId: blocker.entity_id,
    entityRevision: blocker.entity_revision,
    unit: blocker.unit,
    inputDigest: blocker.input_digest,
  });
}

/**
 * Persist the intent (identity + exact input envelope) before any physical
 * send. Idempotent on identity; an existing row with a different canonical
 * input is a digest collision and is rejected, never overwritten.
 */
export async function admitPaidEffectIntent(
  tx: Tx,
  raw: PaidEffectInput,
): Promise<PaidEffectIntentAdmission> {
  const identity = computePaidEffectIdentity(raw);
  const parsedInput = JSON.parse(canonicalizePaidEffectJson(raw.input)) as unknown;
  const inserted = await tx
    .insert(paid_effect)
    .values({
      family: identity.family,
      entity_id: identity.entityId,
      entity_revision: identity.entityRevision,
      unit: identity.unit,
      input_digest: identity.inputDigest,
      input_json: parsedInput,
      state: 'pending',
    })
    .onConflictDoNothing({
      target: [
        paid_effect.family,
        paid_effect.entity_id,
        paid_effect.entity_revision,
        paid_effect.unit,
        paid_effect.input_digest,
      ],
    })
    .returning({ family: paid_effect.family });
  if (inserted.length > 0) return { kind: 'admitted' };
  const row = await lockRow(tx, identity);
  if (!row) throw new PaidEffectProtocolError('paid-effect intent admission did not persist');
  if (!paidEffectJsonEquals(row.input_json, parsedInput)) {
    throw new PaidEffectIdentityConflictError(
      `paid-effect identity ${identity.family}/${identity.entityId}/r${identity.entityRevision}/${identity.unit} maps to a different input than the stored intent`,
    );
  }
  return { kind: 'existing', state: PAID_EFFECT_STATE_SCHEMA.parse(row.state) };
}

async function claimLockedRow(
  tx: Tx,
  row: PaidEffectRow,
  identity: PaidEffectIdentity,
  delivery: PaidEffectSendClaimDelivery,
): Promise<{ fence: number } | { blockedBy: PaidEffectIdentity }> {
  await lockEntityGate(tx, identity);
  // P1-2: control owner/generation verified in the SAME transaction and the
  // SAME lock order as the claim (row → entity advisory → control FOR SHARE),
  // so a concurrent switch (control FOR UPDATE) serializes against every
  // admission and a fenced backend can never win a claim.
  const admission = await admitPaidEffectDeliveryControl(tx, identity.family, {
    backend: delivery.backend,
    deliveryId: delivery.deliveryId,
    tickId: delivery.tickId ?? null,
    generation: delivery.generation ?? null,
  });
  if (admission.kind === 'fenced') {
    throw new PaidEffectControlFencedError(identity.family, admission.reason, admission.owner);
  }
  const blockedBy = await findGateBlocker(tx, identity);
  if (blockedBy) return { blockedBy };
  const fence = row.fence + 1;
  await tx
    .update(paid_effect)
    .set({
      state: 'sending',
      fence,
      delivery_id: delivery.deliveryId,
      delivery_backend: delivery.backend,
      delivery_tick: delivery.tickId ?? null,
      send_lease_expires_at: delivery.leaseExpiresAt,
      unresolved_reason: null,
      updated_at: new Date(),
    })
    .where(and(identityWhere(identity), eq(paid_effect.state, 'pending')));
  return { fence };
}

/**
 * CAS the physical send on an already-admitted intent (callers that manage
 * admission themselves; prefer reservePaidEffect). Only a 'pending' row can be
 * claimed, exactly one delivery wins, and the winner records its
 * fence/delivery/lease. Every other state refuses — an expired lease is an
 * unknown outcome, never a new ticket back to a paid call. Control admission
 * is embedded: a fenced backend/stale generation THROWS instead of winning.
 */
export async function claimPaidEffectSend(
  tx: Tx,
  identity: PaidEffectIdentity,
  delivery: PaidEffectSendClaimDelivery,
): Promise<PaidEffectSendClaim> {
  const row = await lockRow(tx, identity);
  if (!row) return { kind: 'missing' };
  if (row.state !== 'pending') {
    return {
      kind: 'refused',
      state: PAID_EFFECT_STATE_SCHEMA.parse(row.state),
      receiptKnown: row.state === 'receipt_ready' || row.state === 'applied',
      blockedBy: null,
    };
  }
  const outcome = await claimLockedRow(tx, row, identity, delivery);
  if ('blockedBy' in outcome) {
    return { kind: 'refused', state: 'pending', receiptKnown: false, blockedBy: outcome.blockedBy };
  }
  return { kind: 'claimed', fence: outcome.fence };
}

/**
 * THE send admission for consumers (A/C): persist the intent and admit the
 * physical send in ONE transaction over the locked identity row, then answer
 * with the pinned reserve discrimination. Two consumers that both read
 * "empty" and try to start the same effect serialize here: exactly one leaves
 * as the winner, the other as held — an append with no return can never serve
 * as send admission. Control admission, the entity gate, and the claim commit
 * atomically; a fenced delivery surfaces as PaidEffectControlFencedError.
 */
export async function reservePaidEffect(
  db: Db,
  input: PaidEffectInput,
  delivery: PaidEffectSendClaimDelivery,
): Promise<PaidEffectReservation & { readonly identity: PaidEffectIdentity }> {
  const identity = computePaidEffectIdentity(input);
  return db.transaction(async (tx) => {
    await admitPaidEffectIntent(tx, input);
    const row = await lockRow(tx, identity);
    if (!row) throw new PaidEffectProtocolError('paid-effect reservation lost its row');
    const state = PAID_EFFECT_STATE_SCHEMA.parse(row.state);
    if (state === 'receipt_ready' || state === 'applied') {
      return {
        identity,
        kind: 'completed',
        state,
        result: row.result_json,
        application: row.application_json,
        applied: state === 'applied',
      } as const;
    }
    if (state === 'sending' || state === 'unknown') {
      return { identity, kind: 'held', state, blockedBy: null } as const;
    }
    const outcome = await claimLockedRow(tx, row, identity, delivery);
    if ('blockedBy' in outcome) {
      return { identity, kind: 'held', state: 'pending', blockedBy: outcome.blockedBy } as const;
    }
    return { identity, kind: 'winner', fence: outcome.fence } as const;
  });
}

function requireOwnerDelivery(
  row: PaidEffectRow,
  identity: PaidEffectIdentity,
  deliveryId: string,
  expectedFence: number,
): void {
  if (row.delivery_id !== deliveryId) {
    throw new PaidEffectDeliveryConflictError(
      `delivery ${deliveryId} does not own the admitted send for ${identity.family}/${identity.entityId}`,
    );
  }
  if (row.fence !== expectedFence) {
    throw new PaidEffectDeliveryConflictError(
      `delivery ${deliveryId} fence ${expectedFence} is stale for ${identity.family}/${identity.entityId} (row fence ${row.fence})`,
    );
  }
}

/**
 * Record the exact immutable result receipt — completable only by the winning
 * delivery (and, when passed, only with the winner's fence). Re-writing a
 * semantically equal receipt is idempotent; an unequal rewrite is rejected
 * without mutating the row. A late receipt resolving an 'unknown' row is
 * monotone information gain and stays allowed for the owning delivery.
 */
export async function recordPaidEffectResult(
  tx: Tx,
  identity: PaidEffectIdentity,
  deliveryId: string,
  receipt: unknown,
  opts: { fence: number },
): Promise<'recorded' | 'idempotent'> {
  // Reject non-canonicalizable payloads before touching the row.
  canonicalizePaidEffectJson(receipt);
  const row = await lockRow(tx, identity);
  if (!row) throw new PaidEffectProtocolError('paid-effect row missing');
  if (row.state === 'receipt_ready' || row.state === 'applied') {
    if (paidEffectJsonEquals(row.result_json, receipt)) return 'idempotent';
    throw new PaidEffectReceiptConflictError(
      `paid-effect receipt for ${identity.family}/${identity.entityId}/r${identity.entityRevision}/${identity.unit} already exists and differs from the new payload`,
    );
  }
  if (row.state === 'pending') {
    throw new PaidEffectProtocolError('cannot record a result without an admitted send');
  }
  requireOwnerDelivery(row, identity, deliveryId, opts.fence);
  await tx
    .update(paid_effect)
    .set({
      state: 'receipt_ready',
      result_json: receipt,
      result_recorded_at: new Date(),
      send_lease_expires_at: null,
      unresolved_reason: null,
      updated_at: new Date(),
    })
    .where(and(identityWhere(identity), inArray(paid_effect.state, ['sending', 'unknown'])));
  return 'recorded';
}

/**
 * Classify an admitted-but-unresolved send as an unknown outcome (durable
 * unresolved obligation). Classification only — nothing here retries.
 */
export async function markPaidEffectUnknown(
  tx: Tx,
  identity: PaidEffectIdentity,
  deliveryId: string,
  reason: string,
  opts: { fence: number },
): Promise<void> {
  const row = await lockRow(tx, identity);
  if (!row) throw new PaidEffectProtocolError('paid-effect row missing');
  if (row.state === 'unknown') return;
  if (row.state === 'receipt_ready' || row.state === 'applied') {
    throw new PaidEffectProtocolError('outcome already known; refusing to mark unknown');
  }
  if (row.state === 'pending') {
    throw new PaidEffectProtocolError('no send admitted; nothing to mark unknown');
  }
  requireOwnerDelivery(row, identity, deliveryId, opts.fence);
  await tx
    .update(paid_effect)
    .set({
      state: 'unknown',
      send_lease_expires_at: null,
      unresolved_reason: reason,
      updated_at: new Date(),
    })
    .where(and(identityWhere(identity), eq(paid_effect.state, 'sending')));
}

/**
 * Recovery sweep: sends whose lease expired without a receipt become unknown
 * obligations. Returns the number of rows classified.
 */
export async function settleExpiredPaidEffectSends(
  db: Db,
  opts: { family?: string; now?: Date } = {},
): Promise<number> {
  const now = opts.now ?? new Date();
  const conditions: SQL[] = [
    eq(paid_effect.state, 'sending'),
    lt(paid_effect.send_lease_expires_at, now),
  ];
  if (opts.family !== undefined) conditions.push(eq(paid_effect.family, opts.family));
  const rows = await db
    .update(paid_effect)
    .set({
      state: 'unknown',
      send_lease_expires_at: null,
      unresolved_reason: 'send_lease_expired',
      updated_at: now,
    })
    .where(and(...conditions))
    .returning({ family: paid_effect.family });
  return rows.length;
}

/**
 * Record an application failure WITHOUT changing state: the row stays
 * receipt_ready (readable unfinished obligation) and the only way forward is
 * retrying the application from the receipt — never a new physical send.
 */
export async function notePaidEffectApplicationFailure(
  tx: Tx,
  identity: PaidEffectIdentity,
  error: string,
): Promise<void> {
  const row = await lockRow(tx, identity);
  if (!row) throw new PaidEffectProtocolError('paid-effect row missing');
  if (row.state !== 'receipt_ready') {
    throw new PaidEffectProtocolError('application failure noted only in receipt_ready');
  }
  await tx
    .update(paid_effect)
    .set({
      application_attempts: row.application_attempts + 1,
      last_application_error: error.slice(0, 500),
      updated_at: new Date(),
    })
    .where(and(identityWhere(identity), eq(paid_effect.state, 'receipt_ready')));
}

/**
 * Record the application receipt. Idempotent when the application payload is
 * semantically equal to the recorded one; an unequal rewrite is rejected.
 */
export async function recordPaidEffectApplication(
  tx: Tx,
  identity: PaidEffectIdentity,
  application: unknown,
): Promise<'applied' | 'idempotent'> {
  canonicalizePaidEffectJson(application);
  const row = await lockRow(tx, identity);
  if (!row) throw new PaidEffectProtocolError('paid-effect row missing');
  if (row.state === 'applied') {
    if (paidEffectJsonEquals(row.application_json, application)) return 'idempotent';
    throw new PaidEffectApplicationConflictError(
      `paid-effect application for ${identity.family}/${identity.entityId}/r${identity.entityRevision}/${identity.unit} already exists and differs from the new payload`,
    );
  }
  if (row.state !== 'receipt_ready') {
    throw new PaidEffectProtocolError('application requires a recorded receipt');
  }
  await tx
    .update(paid_effect)
    .set({
      state: 'applied',
      application_json: application,
      applied_at: new Date(),
      updated_at: new Date(),
    })
    .where(and(identityWhere(identity), eq(paid_effect.state, 'receipt_ready')));
  return 'applied';
}

export async function readPaidEffect(
  db: Db | Tx,
  identity: PaidEffectIdentity,
): Promise<PaidEffectSnapshot | null> {
  const rows = await db.select().from(paid_effect).where(identityWhere(identity)).limit(1);
  const row = rows[0];
  return row ? toSnapshot(row) : null;
}

/** Unfinished obligations, readable regardless of any workflow's status. */
export async function listPaidEffectObligations(
  db: Db,
  opts: {
    family?: string;
    states?: readonly PaidEffectState[];
    limit?: number;
  } = {},
): Promise<PaidEffectObligationView[]> {
  const states = opts.states ?? (['pending', 'sending', 'unknown', 'receipt_ready'] as const);
  const conditions: SQL[] = [inArray(paid_effect.state, [...states])];
  if (opts.family !== undefined) conditions.push(eq(paid_effect.family, opts.family));
  const rows = await db
    .select()
    .from(paid_effect)
    .where(and(...conditions))
    .orderBy(paid_effect.family, paid_effect.created_at, paid_effect.entity_id)
    .limit(opts.limit ?? 1000);
  return rows.map(toSnapshot);
}
