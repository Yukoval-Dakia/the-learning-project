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
//   rejected), completable only by the winning delivery and exact fence;
// - unknown outcomes are durable unresolved obligations, never auto-replayed,
//   including under a new tick or a new revision/workset of the same entity —
//   enforced by the fixed entity gate with only A's recognized rep exemption;
// - failed application leaves the row in receipt_ready (readable unfinished
//   obligation) and the only way forward is replaying the application from the
//   receipt — there is no path back to a physical send.
import { type SQL, and, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import {
  PAID_EFFECT_AUTHORIZATION_OPEN_STATES,
  PAID_EFFECT_BACKEND_SCHEMA,
  PAID_EFFECT_ENTITY_GATE_STATES,
  PAID_EFFECT_PARALLEL_REP_UNIT_PATTERN,
  PAID_EFFECT_STATE_SCHEMA,
  PaidEffectApplicationConflictError,
  PaidEffectAuthorizationError,
  type PaidEffectBackend,
  type PaidEffectCancelReceipt,
  type PaidEffectCancelRequest,
  PaidEffectCancellationError,
  PaidEffectControlFencedError,
  PaidEffectDeliveryConflictError,
  type PaidEffectIdentity,
  PaidEffectIdentityConflictError,
  type PaidEffectInput,
  PaidEffectProtocolError,
  PaidEffectReceiptConflictError,
  type PaidEffectReservation,
  type PaidEffectState,
  type PaidEffectVoidAuthorization,
  type PaidEffectVoidReceipt,
  canonicalizePaidEffectJson,
  computePaidEffectIdentity,
  paidEffectGateLockKey,
  paidEffectIdentitySchema,
  paidEffectJsonEquals,
} from '@/core/migration/paid-effect-protocol';
import type { Db, Tx } from '@/db/client';
import {
  admitPaidEffectDeliveryControl,
  lockPaidEffectControlFamily,
} from '@/db/paid-effect-control';
import {
  event,
  event_subscription_delivery,
  paid_effect,
  paid_effect_authorization,
  paid_effect_cancellation,
} from '@/db/schema';

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
  readonly voidedAt: Date | null;
  readonly voidReceipt: unknown;
  readonly cancelledAt: Date | null;
  readonly cancelReceipt: unknown;
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
  /** Original dispatch generation; required for both backends after bootstrap. */
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
    voidedAt: row.voided_at,
    voidReceipt: row.void_json,
    cancelledAt: row.cancelled_at,
    cancelReceipt: row.cancel_json,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function lockRow(tx: Tx, identity: PaidEffectIdentity): Promise<PaidEffectRow | null> {
  // Result/application writes can be composed with admission in one tx too.
  // Keep every store row lock behind the family lock, not just send claims.
  await lockPaidEffectControlFamily(tx, identity.family);
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
 * UNLESS it is an item_prior_backfill feature rep of the SAME revision.
 * Same revision + same unit
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
        // Mirrors paidEffectGateBlocks: only A's recognized feature siblings.
        sql`not (
          ${paid_effect.family} = 'item_prior_backfill'
          and ${identity.family} = 'item_prior_backfill'
          and ${paid_effect.unit} ~ ${PAID_EFFECT_PARALLEL_REP_UNIT_PATTERN}
          and ${identity.unit} ~ ${PAID_EFFECT_PARALLEL_REP_UNIT_PATTERN}
          and ${paid_effect.entity_revision} = ${identity.entityRevision}
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
  // Lowest public admission must serialize BEFORE INSERT or a conflict row
  // lock, including callers that then claim in this same transaction.
  await lockPaidEffectControlFamily(tx, identity.family);
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

type AuthorizationRow = typeof paid_effect_authorization.$inferSelect;

const OPEN_SUCCESSOR_STATES: readonly string[] = PAID_EFFECT_AUTHORIZATION_OPEN_STATES;

function successorIdentityOf(auth: AuthorizationRow): PaidEffectIdentity {
  return {
    family: auth.family,
    entityId: auth.entity_id,
    entityRevision: auth.successor_entity_revision,
    unit: auth.successor_unit,
    inputDigest: auth.successor_input_digest,
  };
}

function voidedIdentityOf(auth: AuthorizationRow): PaidEffectIdentity {
  return {
    family: auth.family,
    entityId: auth.entity_id,
    entityRevision: auth.entity_revision,
    unit: auth.unit,
    inputDigest: auth.input_digest,
  };
}

function sameIdentity(a: PaidEffectIdentity, b: PaidEffectIdentity): boolean {
  return (
    a.family === b.family &&
    a.entityId === b.entityId &&
    a.entityRevision === b.entityRevision &&
    a.unit === b.unit &&
    a.inputDigest === b.inputDigest
  );
}

/**
 * THE successor-authorization gate (YUK-1567). Runs inside the caller's
 * transaction after lockEntityGate, serialized by the same family advisory +
 * entity-gate locks as the void that wrote the authorization. While ANY
 * authorization for this (family, entityId) is still open — its successor row
 * missing or not yet terminal — only the authorized successor identity may be
 * claimed, and only by the exact bound delivery. A claim on the successor
 * identity under any other delivery throws (fail-closed) so the delivery
 * visibly fails instead of silently holding a parked intent; a claim on any
 * other identity is blocked with the voided row named as the blocker.
 */
async function checkSuccessorAuthorization(
  tx: Tx,
  identity: PaidEffectIdentity,
  delivery: PaidEffectSendClaimDelivery,
): Promise<PaidEffectIdentity | null> {
  const auths = await tx
    .select()
    .from(paid_effect_authorization)
    .where(
      and(
        eq(paid_effect_authorization.family, identity.family),
        eq(paid_effect_authorization.entity_id, identity.entityId),
      ),
    )
    .for('update');
  for (const auth of auths) {
    const successor = successorIdentityOf(auth);
    const [succ] = await tx
      .select({ state: paid_effect.state })
      .from(paid_effect)
      .where(identityWhere(successor))
      .limit(1);
    // Missing cannot happen when the void admitted the intent atomically, but
    // a missing successor must still read as OPEN — never treat absence as
    // settled and let an unrelated claim through the gate.
    const open = succ == null || OPEN_SUCCESSOR_STATES.includes(succ.state);
    if (!open) continue;
    if (sameIdentity(identity, successor)) {
      if (
        delivery.backend !== auth.successor_delivery_backend ||
        delivery.deliveryId !== auth.successor_delivery_id
      ) {
        throw new PaidEffectAuthorizationError(
          `paid-effect delivery ${delivery.deliveryId} is not the authorized successor delivery ` +
            `(${auth.successor_delivery_backend}/${auth.successor_delivery_id}) for ` +
            `${identity.family}/${identity.entityId} under authorization ${auth.authorization_id}`,
        );
      }
      continue;
    }
    return voidedIdentityOf(auth);
  }
  return null;
}

/** Audit marker: the bound delivery consumed its authorization on claim. */
async function markAuthorizationConsumed(
  tx: Tx,
  identity: PaidEffectIdentity,
  delivery: PaidEffectSendClaimDelivery,
): Promise<void> {
  await tx
    .update(paid_effect_authorization)
    .set({ consumed_at: new Date(), consumed_delivery_id: delivery.deliveryId })
    .where(
      and(
        eq(paid_effect_authorization.family, identity.family),
        eq(paid_effect_authorization.entity_id, identity.entityId),
        eq(paid_effect_authorization.successor_entity_revision, identity.entityRevision),
        eq(paid_effect_authorization.successor_unit, identity.unit),
        eq(paid_effect_authorization.successor_input_digest, identity.inputDigest),
        isNull(paid_effect_authorization.consumed_at),
      ),
    );
}

async function claimLockedRow(
  tx: Tx,
  row: PaidEffectRow,
  identity: PaidEffectIdentity,
  delivery: PaidEffectSendClaimDelivery,
): Promise<{ fence: number } | { blockedBy: PaidEffectIdentity }> {
  await lockEntityGate(tx, identity);
  // P1-2: control owner/generation verified in the SAME transaction and the
  // SAME lock order as the claim (family → row → entity → control FOR SHARE),
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
  const authBlocker = await checkSuccessorAuthorization(tx, identity, delivery);
  if (authBlocker) return { blockedBy: authBlocker };
  const fence = row.fence + 1;
  const claimed = await tx
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
    .where(and(identityWhere(identity), eq(paid_effect.state, 'pending')))
    .returning({ family: paid_effect.family });
  // The row was locked FOR UPDATE as 'pending', so zero rows means a state we
  // failed to discriminate — never report a send the CAS did not mint.
  if (claimed.length !== 1) {
    throw new PaidEffectProtocolError(
      `paid-effect claim CAS did not apply for ${identity.family}/${identity.entityId}`,
    );
  }
  // The bound delivery consumed its authorization — record it AFTER the CAS
  // win so a claim that could not win never marks anything consumed.
  await markAuthorizationConsumed(tx, identity, delivery);
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
  // FIRST: the family control lock, before any other lock in this
  // transaction — the pinned order is family-control advisory → identity row
  // → entity advisory → control row (reentrant no-op inside admit).
  await lockPaidEffectControlFamily(tx, identity.family);
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
    // FIRST: the family control lock, before the intent insert and the row
    // lock — same pinned order as claimPaidEffectSend and the switch.
    await lockPaidEffectControlFamily(tx, identity.family);
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
    if (state === 'sending' || state === 'unknown' || state === 'voided' || state === 'cancelled') {
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
 * delivery and exact winner fence, including equal-receipt retries. Re-writing a
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
    requireOwnerDelivery(row, identity, deliveryId, opts.fence);
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
  if (row.state === 'unknown') {
    requireOwnerDelivery(row, identity, deliveryId, opts.fence);
    return;
  }
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

export type PaidEffectVoidOutcome =
  | {
      readonly kind: 'voided';
      readonly authorizationId: string;
      readonly voided: PaidEffectIdentity;
      readonly successor: PaidEffectIdentity;
      readonly voidedAt: Date;
      /** New fence on the voided row; late writes under previousFence die. */
      readonly fence: number;
    }
  | {
      readonly kind: 'already_voided';
      readonly authorizationId: string;
      readonly voided: PaidEffectIdentity;
      readonly successor: PaidEffectIdentity;
    };

/**
 * THE manual void + successor reauthorization (YUK-1567). One call, inside the
 * caller's transaction, atomically:
 *   1. CAS the locked 'unknown' row to 'voided' (identity + fence; fence
 *      bumps so the retired delivery's late receipt/unknown-marking is
 *      rejected by the same owner/fence CAS as every other write),
 *   2. persist the authorization row (reason / operator / basis / exact
 *      successor identity / exact bound delivery),
 *   3. admit the successor's pending intent — so the authorization and its
 *      reservation commit or roll back TOGETHER and no background claim can
 *      race into the voided gap.
 * Only an explicit 'unknown' row may be voided (a 'sending' row has an active
 * send; 'pending' is an un-sent intent; receipts/applied are paid truth).
 * Replaying with the same authorizationId returns 'already_voided' and mints
 * nothing; replaying under a different id is a conflict error, not a second
 * receipt. Several rows may be voided under ONE authorizationId for the same
 * successor inside one transaction (multi-blocker entity): the second call
 * recognizes its own freshly-bound successor and admits nothing twice.
 */
export async function voidPaidEffectWithSuccessor(
  tx: Tx,
  identity: PaidEffectIdentity,
  opts: { expectedFence: number; authorization: PaidEffectVoidAuthorization },
): Promise<PaidEffectVoidOutcome> {
  const auth = opts.authorization;
  const successor = computePaidEffectIdentity(auth.successorInput);
  if (successor.family !== identity.family || successor.entityId !== identity.entityId) {
    throw new PaidEffectAuthorizationError(
      'paid-effect void successor must stay within the same family and entity',
    );
  }
  if (sameIdentity(successor, identity)) {
    throw new PaidEffectAuthorizationError(
      'paid-effect void successor must be a different identity than the voided row',
    );
  }
  const row = await lockRow(tx, identity);
  if (!row) throw new PaidEffectProtocolError('paid-effect row missing');
  const existingReceipt = row.void_json as PaidEffectVoidReceipt | null;
  if (row.state === 'voided') {
    if (existingReceipt?.authorizationId === auth.authorizationId) {
      return {
        kind: 'already_voided',
        authorizationId: auth.authorizationId,
        voided: identity,
        successor: existingReceipt.successor,
      };
    }
    throw new PaidEffectAuthorizationError(
      `paid-effect ${identity.family}/${identity.entityId} is already voided under ` +
        `authorization ${existingReceipt?.authorizationId ?? '<missing receipt>'}; ` +
        'refusing a second authorization receipt',
    );
  }
  if (row.state !== 'unknown') {
    throw new PaidEffectProtocolError(
      `paid-effect void requires an explicit 'unknown' obligation; ` +
        `${identity.family}/${identity.entityId} is '${row.state}'`,
    );
  }
  if (row.fence !== opts.expectedFence) {
    throw new PaidEffectDeliveryConflictError(
      `paid-effect void fence ${opts.expectedFence} is stale for ` +
        `${identity.family}/${identity.entityId} (row fence ${row.fence})`,
    );
  }
  // Entity-scope mutation: same lock order as a claim (family advisory →
  // identity row → entity advisory), so the authorization write serializes
  // against every claim's authorization scan.
  await lockEntityGate(tx, identity);
  const [succRow] = await tx
    .select({ state: paid_effect.state })
    .from(paid_effect)
    .where(identityWhere(successor))
    .for('update')
    .limit(1);
  const [priorBinding] = await tx
    .select()
    .from(paid_effect_authorization)
    .where(
      and(
        eq(paid_effect_authorization.family, identity.family),
        eq(paid_effect_authorization.entity_id, identity.entityId),
        eq(paid_effect_authorization.successor_entity_revision, successor.entityRevision),
        eq(paid_effect_authorization.successor_unit, successor.unit),
        eq(paid_effect_authorization.successor_input_digest, successor.inputDigest),
      ),
    )
    .for('update')
    .limit(1);
  if (priorBinding) {
    const ours =
      priorBinding.authorization_id === auth.authorizationId &&
      priorBinding.successor_delivery_backend === auth.successorDelivery.backend &&
      priorBinding.successor_delivery_id === auth.successorDelivery.deliveryId;
    if (!ours || !succRow || succRow.state !== 'pending') {
      throw new PaidEffectAuthorizationError(
        `paid-effect successor for ${identity.family}/${identity.entityId} is already bound ` +
          'by a different authorization or no longer pending; refusing to re-bind',
      );
    }
    // Same void batch already bound + admitted this successor — continue.
  } else if (succRow) {
    throw new PaidEffectAuthorizationError(
      `paid-effect successor identity for ${identity.family}/${identity.entityId} already ` +
        'has an effect row; refusing to double-spend the authorized send',
    );
  }
  await tx.insert(paid_effect_authorization).values({
    family: identity.family,
    entity_id: identity.entityId,
    entity_revision: identity.entityRevision,
    unit: identity.unit,
    input_digest: identity.inputDigest,
    authorization_id: auth.authorizationId,
    successor_entity_revision: successor.entityRevision,
    successor_unit: successor.unit,
    successor_input_digest: successor.inputDigest,
    successor_delivery_backend: auth.successorDelivery.backend,
    successor_delivery_id: auth.successorDelivery.deliveryId,
    reason: auth.reason,
    operator: auth.operator,
    basis: auth.basis,
  });
  if (!priorBinding) {
    const admission = await admitPaidEffectIntent(tx, auth.successorInput);
    if (admission.kind !== 'admitted') {
      throw new PaidEffectProtocolError(
        'paid-effect void successor intent was not freshly admitted',
      );
    }
  }
  const now = new Date();
  const receipt: PaidEffectVoidReceipt = {
    authorizationId: auth.authorizationId,
    reason: auth.reason,
    operator: auth.operator,
    basis: auth.basis,
    voidedFromState: 'unknown',
    previousFence: row.fence,
    successor,
    successorDelivery: auth.successorDelivery,
  };
  const fence = row.fence + 1;
  const updated = await tx
    .update(paid_effect)
    .set({
      state: 'voided',
      fence,
      voided_at: now,
      void_json: receipt,
      updated_at: now,
    })
    .where(
      and(
        identityWhere(identity),
        eq(paid_effect.state, 'unknown'),
        eq(paid_effect.fence, opts.expectedFence),
      ),
    )
    .returning({ family: paid_effect.family });
  if (updated.length !== 1) {
    throw new PaidEffectDeliveryConflictError(
      `paid-effect void CAS did not apply for ${identity.family}/${identity.entityId}`,
    );
  }
  return {
    kind: 'voided',
    authorizationId: auth.authorizationId,
    voided: identity,
    successor,
    voidedAt: now,
    fence,
  };
}

/**
 * All authorization rows for one (family, entityId) — the void CLI's plan and
 * the driver's verification read; not part of the claim hot path.
 */
export async function readPaidEffectAuthorizations(
  db: Db | Tx,
  scope: { family: string; entityId: string },
): Promise<AuthorizationRow[]> {
  return db
    .select()
    .from(paid_effect_authorization)
    .where(
      and(
        eq(paid_effect_authorization.family, scope.family),
        eq(paid_effect_authorization.entity_id, scope.entityId),
      ),
    );
}

type CancellationRow = typeof paid_effect_cancellation.$inferSelect;

export type PaidEffectCancelOutcome =
  | {
      readonly kind: 'cancelled';
      readonly requestId: string;
      readonly cancelled: PaidEffectIdentity;
      readonly cancelledAt: Date;
      /** New fence on the cancelled row; stale fence tokens die. */
      readonly fence: number;
    }
  | {
      readonly kind: 'already_cancelled';
      readonly requestId: string;
      readonly cancelled: PaidEffectIdentity;
      readonly receipt: PaidEffectCancelReceipt;
    };

/**
 * THE generic cancel of a never-sent intent (YUK-1567). One call, inside the
 * caller's transaction, atomically:
 *   1. prove the locked row is a 'pending' intent that was NEVER sent
 *      (delivery/backend/tick null, no lease, no result, no application,
 *      fence === expectedFence),
 *   2. refuse when the intent is the bound successor of a
 *      paid_effect_authorization row (this slice never unbinds an
 *      authorization gate),
 *   3. insert the immutable cancellation EVENT row
 *      (requestId / operator / reason / basis / previous fence), and
 *   4. CAS pending → cancelled with a fence bump, persisting the cancellation
 *      receipt on the row.
 * The event insert and the state CAS commit or roll back TOGETHER — a failed
 * event aborts the transition. Only 'pending' may be cancelled: 'sending' has
 * a live send, 'unknown' is an unresolved obligation (void + successor owns
 * its retirement), and receipts/applied are paid truth. The never-sent fence
 * is literal: BOTH the request's expectedFence and the row's live fence must
 * be exactly 0 — any advanced fence means a claim already touched the row.
 * Replaying the request returns 'already_cancelled' with the stored receipt
 * ONLY when every request field (requestId, reason, operator, basis), the
 * full identity, and the receipt's previousFence all match; ANY divergence
 * or a different requestId throws — replay never mints a second event and
 * never mutates the recorded receipt.
 */
export async function cancelPaidEffectUnsentIntent(
  tx: Tx,
  identity: PaidEffectIdentity,
  opts: { expectedFence: number; cancellation: PaidEffectCancelRequest },
): Promise<PaidEffectCancelOutcome> {
  const request = opts.cancellation;
  if (opts.expectedFence !== 0) {
    throw new PaidEffectCancellationError(
      `paid-effect cancel requires the literal never-sent fence 0; ` +
        `manifest expected_fence ${opts.expectedFence} is not a valid cancel token`,
    );
  }
  // Same pinned order as a claim/void: family advisory → identity row →
  // entity advisory, so a cancel serializes against every real send claim —
  // exactly one of them commits.
  const row = await lockRow(tx, identity);
  if (!row) throw new PaidEffectProtocolError('paid-effect row missing');
  const existing = row.cancel_json as PaidEffectCancelReceipt | null;
  if (row.state === 'cancelled') {
    // Replay is identified by the FULL recorded request, not the id alone:
    // every audit field, the embedded identity, and the retired fence must
    // match before the stored receipt is returned. Anything else fails
    // closed — a borrowed request id never laundered through an old receipt.
    const replayMatches =
      existing !== null &&
      existing.requestId === request.requestId &&
      existing.reason === request.reason &&
      existing.operator === request.operator &&
      existing.basis === request.basis &&
      existing.previousFence === opts.expectedFence &&
      existing.identity.family === identity.family &&
      existing.identity.entityId === identity.entityId &&
      existing.identity.entityRevision === identity.entityRevision &&
      existing.identity.unit === identity.unit &&
      existing.identity.inputDigest === identity.inputDigest;
    if (replayMatches) {
      return {
        kind: 'already_cancelled',
        requestId: request.requestId,
        cancelled: identity,
        receipt: existing,
      };
    }
    throw new PaidEffectCancellationError(
      `paid-effect ${identity.family}/${identity.entityId} is already cancelled under ` +
        `request ${existing?.requestId ?? '<missing receipt>'} and the replay ` +
        `diverges in request fields, identity, or expected fence; ` +
        'refusing to mint or mutate a cancellation event',
    );
  }
  if (row.state !== 'pending') {
    throw new PaidEffectProtocolError(
      `paid-effect cancel requires a never-sent 'pending' intent; ` +
        `${identity.family}/${identity.entityId} is '${row.state}'`,
    );
  }
  if (row.fence !== 0) {
    throw new PaidEffectDeliveryConflictError(
      `paid-effect cancel requires fence 0 (never claimed); ` +
        `${identity.family}/${identity.entityId} has row fence ${row.fence}`,
    );
  }
  // The never-sent predicate is verified explicitly, not assumed from the
  // state CHECK — any send/lease/receipt/application evidence refuses the
  // cancel even if a future shape ever let it onto a pending row.
  if (
    row.delivery_id !== null ||
    row.delivery_backend !== null ||
    row.delivery_tick !== null ||
    row.send_lease_expires_at !== null ||
    row.result_json !== null ||
    row.result_recorded_at !== null ||
    row.application_json !== null ||
    row.applied_at !== null
  ) {
    throw new PaidEffectProtocolError(
      `paid-effect cancel found send or receipt evidence on ` +
        `${identity.family}/${identity.entityId}; the intent is not never-sent`,
    );
  }
  // Entity-scope check: same lock order as a claim, so the authorization scan
  // serializes against every concurrent claim and void on the entity.
  await lockEntityGate(tx, identity);
  const [binding] = await tx
    .select({ authorization_id: paid_effect_authorization.authorization_id })
    .from(paid_effect_authorization)
    .where(
      and(
        eq(paid_effect_authorization.family, identity.family),
        eq(paid_effect_authorization.entity_id, identity.entityId),
        eq(paid_effect_authorization.successor_entity_revision, identity.entityRevision),
        eq(paid_effect_authorization.successor_unit, identity.unit),
        eq(paid_effect_authorization.successor_input_digest, identity.inputDigest),
      ),
    )
    .for('update')
    .limit(1);
  if (binding) {
    throw new PaidEffectAuthorizationError(
      `paid-effect ${identity.family}/${identity.entityId} is the bound successor of ` +
        `authorization ${binding.authorization_id}; refusing to cancel an authorized send`,
    );
  }
  const now = new Date();
  const receipt: PaidEffectCancelReceipt = {
    requestId: request.requestId,
    reason: request.reason,
    operator: request.operator,
    basis: request.basis,
    cancelledFromState: 'pending',
    previousFence: row.fence,
    identity,
    cancelledAt: now.toISOString(),
  };
  // The cancellation EVENT — durable audit truth. Inserted before the CAS so
  // an event failure (e.g. a second event for this identity) aborts the
  // transition with it.
  await tx.insert(paid_effect_cancellation).values({
    family: identity.family,
    entity_id: identity.entityId,
    entity_revision: identity.entityRevision,
    unit: identity.unit,
    input_digest: identity.inputDigest,
    request_id: request.requestId,
    reason: request.reason,
    operator: request.operator,
    basis: request.basis,
    cancelled_from_state: 'pending',
    previous_fence: row.fence,
  });
  const fence = row.fence + 1;
  const updated = await tx
    .update(paid_effect)
    .set({
      state: 'cancelled',
      fence,
      cancelled_at: now,
      cancel_json: receipt,
      updated_at: now,
    })
    .where(
      and(
        identityWhere(identity),
        eq(paid_effect.state, 'pending'),
        eq(paid_effect.fence, opts.expectedFence),
      ),
    )
    .returning({ family: paid_effect.family });
  if (updated.length !== 1) {
    throw new PaidEffectDeliveryConflictError(
      `paid-effect cancel CAS did not apply for ${identity.family}/${identity.entityId}`,
    );
  }
  return {
    kind: 'cancelled',
    requestId: request.requestId,
    cancelled: identity,
    cancelledAt: now,
    fence,
  };
}

/** The ops-gate predicate the cancel CLI shares between plan and apply. */
export interface PaidEffectCancelEligibility {
  readonly eligible: boolean;
  readonly failures: readonly string[];
  /** Observed row evidence; null when the identity has no row. */
  readonly observed: {
    readonly state: PaidEffectState;
    readonly fence: number;
    readonly createdAt: Date;
    readonly updatedAt: Date;
  } | null;
}

/**
 * Read-side eligibility predicate for cancelling a never-sent intent — the
 * SAME checks the ops CLI freezes in plan and re-verifies under the apply
 * transaction's locks before any write. Pure SELECTs; the caller's
 * transaction supplies the isolation/locks. A target is eligible only when:
 *   - the row exists, is 'pending', carries the expected fence, and shows NO
 *     send/lease/receipt/application evidence;
 *   - it is NOT the bound successor of a paid_effect_authorization row;
 *   - no 'sending' sibling exists for the same (family, entityId);
 *   - no non-terminal pg-boss job of the family references the entity;
 *   - no non-terminal event_subscription_delivery references the entity; and
 *   - every declared watch (action, subscriberId, subscriberVersion) has a
 *     delivery row — at the CURRENT declared version — for every matching
 *     event; an old-version delivery does not prove this version saw it.
 * Any read failure fails closed (the caller's transaction aborts).
 */
export async function evaluatePaidEffectCancelEligibility(
  tx: Tx,
  identity: PaidEffectIdentity,
  opts: {
    expectedFence: number;
    watch: readonly { action: string; subscriberId: string; subscriberVersion: number }[];
  },
): Promise<PaidEffectCancelEligibility> {
  const failures: string[] = [];
  if (opts.expectedFence !== 0) {
    failures.push(`expected_fence ${opts.expectedFence} is not the literal never-sent 0`);
  }
  const rows = await tx
    .select({
      state: paid_effect.state,
      fence: paid_effect.fence,
      delivery_id: paid_effect.delivery_id,
      delivery_backend: paid_effect.delivery_backend,
      delivery_tick: paid_effect.delivery_tick,
      send_lease_expires_at: paid_effect.send_lease_expires_at,
      result_json: paid_effect.result_json,
      result_recorded_at: paid_effect.result_recorded_at,
      application_json: paid_effect.application_json,
      applied_at: paid_effect.applied_at,
      created_at: paid_effect.created_at,
      updated_at: paid_effect.updated_at,
    })
    .from(paid_effect)
    .where(identityWhere(identity))
    .limit(1);
  const row = rows[0];
  let observed: PaidEffectCancelEligibility['observed'] = null;
  if (!row) {
    failures.push('paid-effect row missing for manifest identity');
  } else {
    observed = {
      state: PAID_EFFECT_STATE_SCHEMA.parse(row.state),
      fence: row.fence,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    if (row.state !== 'pending') {
      failures.push(`state '${row.state}' is not 'pending'`);
    }
    if (row.fence !== 0) {
      failures.push(`fence ${row.fence} is not the literal never-sent 0`);
    } else if (row.fence !== opts.expectedFence) {
      failures.push(`fence ${row.fence} != expected_fence ${opts.expectedFence}`);
    }
    const sentEvidence: string[] = [];
    if (row.delivery_id !== null) sentEvidence.push('delivery_id');
    if (row.delivery_backend !== null) sentEvidence.push('delivery_backend');
    if (row.delivery_tick !== null) sentEvidence.push('delivery_tick');
    if (row.send_lease_expires_at !== null) sentEvidence.push('send_lease_expires_at');
    if (row.result_json !== null) sentEvidence.push('result_json');
    if (row.result_recorded_at !== null) sentEvidence.push('result_recorded_at');
    if (row.application_json !== null) sentEvidence.push('application_json');
    if (row.applied_at !== null) sentEvidence.push('applied_at');
    if (sentEvidence.length > 0) {
      failures.push(`send/receipt evidence present: ${sentEvidence.join(',')}`);
    }
  }
  const [binding] = await tx
    .select({ authorization_id: paid_effect_authorization.authorization_id })
    .from(paid_effect_authorization)
    .where(
      and(
        eq(paid_effect_authorization.family, identity.family),
        eq(paid_effect_authorization.entity_id, identity.entityId),
        eq(paid_effect_authorization.successor_entity_revision, identity.entityRevision),
        eq(paid_effect_authorization.successor_unit, identity.unit),
        eq(paid_effect_authorization.successor_input_digest, identity.inputDigest),
      ),
    )
    .limit(1);
  if (binding) {
    failures.push(`bound successor of authorization ${binding.authorization_id}`);
  }
  const inFlight = await tx
    .select({ unit: paid_effect.unit, input_digest: paid_effect.input_digest })
    .from(paid_effect)
    .where(
      and(
        eq(paid_effect.family, identity.family),
        eq(paid_effect.entity_id, identity.entityId),
        eq(paid_effect.state, 'sending'),
      ),
    )
    .limit(10);
  if (inFlight.length > 0) {
    failures.push(
      `in-flight 'sending' sibling(s): ${inFlight.map((r) => `${r.unit}|${r.input_digest}`).join(',')}`,
    );
  }
  // Non-terminal scheduler work that could still claim the intent. The job
  // data shape is family-owned, so the entity match is conservative text
  // containment — a false positive fails closed, never silently cancels.
  // pgboss.job is absent on some ephemeral DBs (to_regclass probe is the
  // repo's non-aborting pattern); its absence means no jobs can exist.
  const [bossTable] = await tx.execute<{ reg: string | null }>(
    sql`select to_regclass('pgboss.job') as reg`,
  );
  if (bossTable.reg === null) {
    failures.push('pgboss.job absent — scheduler liveness could not be verified');
  } else {
    const liveJobs = await tx.execute<{ id: string; name: string; state: string }>(sql`
      select id, name, state::text as state from pgboss.job
      where name = ${identity.family}
        and state in ('created','retry','active')
        and data::text like ${`%${identity.entityId}%`}`);
    if (liveJobs.length > 0) {
      failures.push(
        `non-terminal job(s) referencing entity: ${liveJobs.map((j) => `${j.id}:${j.state}`).join(',')}`,
      );
    }
  }
  const unsettledDeliveries = await tx
    .select({
      subscriber_id: event_subscription_delivery.subscriber_id,
      source_event_id: event_subscription_delivery.source_event_id,
      status: event_subscription_delivery.status,
    })
    .from(event_subscription_delivery)
    .innerJoin(
      event,
      and(
        eq(event.id, event_subscription_delivery.source_event_id),
        eq(event.dispatch_seq, event_subscription_delivery.source_dispatch_seq),
      ),
    )
    .where(
      and(
        inArray(event_subscription_delivery.status, ['pending', 'claimed', 'retry_wait']),
        or(
          eq(event.subject_id, identity.entityId),
          sql`${event.payload}::text like ${`%${identity.entityId}%`}`,
        ),
      ),
    )
    .limit(20);
  if (unsettledDeliveries.length > 0) {
    failures.push(
      `non-terminal subscription deliver${unsettledDeliveries.length === 1 ? 'y' : 'ies'} referencing entity: ${unsettledDeliveries
        .map((d) => `${d.subscriber_id}:${d.source_event_id}:${d.status}`)
        .join(',')}`,
    );
  }
  for (const watch of opts.watch) {
    const undelivered = await tx
      .select({ id: event.id })
      .from(event)
      .where(
        and(
          eq(event.action, watch.action),
          or(
            eq(event.subject_id, identity.entityId),
            sql`${event.payload}::text like ${`%${identity.entityId}%`}`,
          ),
          sql`not exists (
            select 1 from ${event_subscription_delivery} d
            where d.subscriber_id = ${watch.subscriberId}
              and d.subscriber_version = ${watch.subscriberVersion}
              and d.source_event_id = ${event.id}
              and d.source_dispatch_seq = ${event.dispatch_seq})`,
        ),
      )
      .limit(10);
    if (undelivered.length > 0) {
      failures.push(
        `undelivered '${watch.action}' event(s) for subscriber ${watch.subscriberId}: ${undelivered
          .map((e) => e.id)
          .join(',')}`,
      );
    }
  }
  return { eligible: failures.length === 0, failures, observed };
}

/** Cancellation event rows for one (family, entityId) — plan/verify reads. */
export async function readPaidEffectCancellations(
  db: Db | Tx,
  scope: { family: string; entityId: string },
): Promise<CancellationRow[]> {
  return db
    .select()
    .from(paid_effect_cancellation)
    .where(
      and(
        eq(paid_effect_cancellation.family, scope.family),
        eq(paid_effect_cancellation.entity_id, scope.entityId),
      ),
    );
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
