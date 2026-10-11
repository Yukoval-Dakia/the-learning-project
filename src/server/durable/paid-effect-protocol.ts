// YUK-1355 Lane B — shared durable paid-effect protocol (FIXED typed interface).
//
// This module is the contract handed to lanes A/C and the parent: the effect
// identity, delivery/admission, receipt, application and obligation vocabulary
// every paid-effect family shares. It owns no DB access so consumers can depend
// on the types without pulling a runtime. Breaking changes to anything exported
// here require a new protocol version and a parent-coordinated handoff, not an
// in-place edit. Pinned semantics: docs/planning/2026-10-11-yuk1355-paid-effect-protocol.md.
//
// Invariants pinned here (and enforced by the store + DB tests):
// - Effect identity is (family, entityId, entityRevision, unit, inputDigest) and
//   is INDEPENDENT of scheduler delivery identity (deliveryId/tick): the same
//   input re-delivered under any later tick is the SAME effect row.
// - A changed input or revision is a NEW identity; historical obligation rows
//   are never erased and identity columns are never updated.
// - Intent is persisted before the physical send; exactly one delivery may
//   claim the send (row CAS); the result receipt is immutable (semantic JSON
//   equality, unequal rewrite rejected); unknown outcomes are durable
//   unresolved obligations, never auto-replayed — including under a new tick;
//   unfinished obligations stay readable regardless of workflow SUCCESS.
// - Backend ownership is symmetric over pg-boss (default) / DBOS (explicit),
//   fenced by (backend, generation); a switch is blocked while sends are
//   in flight or unknown.
import { createHash } from 'node:crypto';
import { z } from 'zod';

export const PAID_EFFECT_BACKEND_SCHEMA = z.enum(['pg-boss', 'dbos']);
export type PaidEffectBackend = z.infer<typeof PAID_EFFECT_BACKEND_SCHEMA>;

export const PAID_EFFECT_STATE_SCHEMA = z.enum([
  'pending',
  'sending',
  'unknown',
  'receipt_ready',
  'applied',
]);
export type PaidEffectState = z.infer<typeof PAID_EFFECT_STATE_SCHEMA>;

/** Absence of a control row means the bootstrap default owner, never DBOS. */
export const DEFAULT_PAID_EFFECT_BACKEND: PaidEffectBackend = 'pg-boss';
export const DEFAULT_PAID_EFFECT_GENERATION = 0;

export const PAID_EFFECT_DIGEST_PREFIX = 'sha256:';

/** States that make a paid effect an unresolved obligation for readers. */
export const PAID_EFFECT_OBLIGATION_STATES = [
  'pending',
  'sending',
  'unknown',
  'receipt_ready',
] as const satisfies readonly PaidEffectState[];

/**
 * States that block a backend switch (P1-5: block on EVERY unfinished
 * obligation — pending intents and unapplied receipts included). Until the
 * parent defines per-state takeover evidence, ownership moves only over a
 * fully drained family; unfinished work must never silently vanish under a
 * switch.
 */
export const PAID_EFFECT_SWITCH_BLOCKING_STATES = [
  'pending',
  'sending',
  'unknown',
  'receipt_ready',
] as const satisfies readonly PaidEffectState[];

/**
 * Entity-gate states: another effect in one of these states blocks a NEW send
 * claim for the same (family, entityId), subject to the sibling-unit exemption
 * below.
 */
export const PAID_EFFECT_ENTITY_GATE_STATES = [
  'sending',
  'unknown',
] as const satisfies readonly PaidEffectState[];

/** A has zero-based feature reps; llasa has one call and no parallel siblings. */
export const PAID_EFFECT_PARALLEL_REP_UNIT_PATTERN = '^feature/rep:(0|[1-9][0-9]*)$';
const parallelRepUnit = new RegExp(PAID_EFFECT_PARALLEL_REP_UNIT_PATTERN);

/**
 * Open effects gate the entity. Only item_prior_backfill's recognized feature
 * reps of the same revision are parallel siblings. Model/method changes and
 * arbitrary unit strings never bypass an unresolved send.
 * The SQL scan uses the same family, pattern, revision and unit predicates.
 */
export function paidEffectGateBlocks(
  blocker: Pick<PaidEffectIdentity, 'family' | 'entityRevision' | 'unit'>,
  claim: Pick<PaidEffectIdentity, 'family' | 'entityRevision' | 'unit'>,
): boolean {
  const siblingUnitOfSameRevision =
    blocker.family === 'item_prior_backfill' &&
    claim.family === 'item_prior_backfill' &&
    parallelRepUnit.exec(blocker.unit)?.[0] === blocker.unit &&
    parallelRepUnit.exec(claim.unit)?.[0] === claim.unit &&
    blocker.entityRevision === claim.entityRevision &&
    blocker.unit !== claim.unit;
  return !siblingUnitOfSameRevision;
}

/**
 * Serialized per (family, entityId) — NEVER per revision (P1-1): claims for
 * different revisions of one entity must serialize on the same lock so the
 * cross-revision block cannot be raced past.
 */
export function paidEffectGateLockKey(identity: PaidEffectIdentity): string {
  return `paid-effect:gate:v1:${identity.family}:${identity.entityId}`;
}

/**
 * THE family-level serialization lock (P1-R2-1): every control admission and
 * every switch takes it FIRST, in the SAME transaction, BEFORE reading or
 * materializing the control row. A FOR SHARE/UPDATE row lock cannot serialize
 * anything when the row does not exist yet — without this advisory, a
 * bootstrap admission reading "no row = default pg-boss" can race a
 * concurrent switch that inserts + scans + flips ownership and never sees the
 * uncommitted claim. Pinned lock order (acyclic):
 *   control-family advisory → identity row → entity advisory → control row.
 * Re-acquiring the same advisory inside one transaction is a no-op, so
 * admission helpers may take it defensively.
 */
export function paidEffectControlLockKey(family: string): string {
  return `paid-effect:control:v1:${family}`;
}

export const paidEffectIdentitySchema = z.strictObject({
  family: z.string().min(1),
  entityId: z.string().min(1),
  /** Free-form revision coordinate (artifact version, frozen workSetId, …). */
  entityRevision: z.string().min(1),
  unit: z.string().min(1),
  inputDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});
export interface PaidEffectIdentity {
  readonly family: string;
  readonly entityId: string;
  readonly entityRevision: string;
  readonly unit: string;
  readonly inputDigest: string;
}

export interface PaidEffectInput {
  readonly family: string;
  readonly entityId: string;
  /** Revision coordinate: artifact version string, frozen workSetId, … */
  readonly entityRevision: string;
  /**
   * Stable unit discriminator within the entity — and the place where a family
   * encodes its executor-lane coordinates when those are identity (e.g. the
   * calibration second lane: `rejudge:<provider>/<model>`). Delivery identity
   * NEVER goes here.
   */
  readonly unit: string;
  /** Exact provider input envelope; must be canonicalizable lossless JSON. */
  readonly input: unknown;
}

/**
 * Scheduler delivery identity. Audit + fencing metadata ONLY — it never takes
 * part in the effect identity, so a re-delivery under a new tick can never
 * mint a second paid effect for the same input.
 */
export interface PaidEffectDeliveryRef {
  readonly backend: PaidEffectBackend;
  /** pg-boss job id / DBOS workflow id. */
  readonly deliveryId: string;
  /** Scheduler tick identity, when the family is tick-driven. */
  readonly tickId?: string | null;
  /** Persisted dispatch generation, required after bootstrap for either backend. */
  readonly generation?: number | null;
}

/**
 * Input contract for a versioned producer/host. Parse the generation bound to
 * the original dispatch, never a control read taken when consuming an old job.
 * Legacy unversioned refs remain bootstrap-only; this does not change payloads.
 */
export const paidEffectDispatchRefSchema = z.strictObject({
  backend: PAID_EFFECT_BACKEND_SCHEMA,
  deliveryId: z.string().min(1),
  tickId: z.string().min(1).nullish(),
  generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type VerifiedPaidEffectDispatchRef = z.infer<typeof paidEffectDispatchRefSchema>;

export interface PaidEffectControlSnapshot {
  readonly family: string;
  readonly backend: PaidEffectBackend;
  readonly generation: number;
  /** false while the control row is absent (bootstrap default owner). */
  readonly explicit: boolean;
}

export type PaidEffectControlAdmission =
  | { readonly kind: 'admitted'; readonly control: PaidEffectControlSnapshot }
  | {
      readonly kind: 'fenced';
      readonly reason: 'backend_mismatch' | 'stale_generation' | 'missing_generation';
      readonly owner: PaidEffectBackend;
      readonly generation: number;
    };

export class PaidEffectProtocolError extends Error {
  override name = 'PaidEffectProtocolError';
}

export class PaidEffectIdentityConflictError extends PaidEffectProtocolError {
  override name = 'PaidEffectIdentityConflictError';
}

export class PaidEffectReceiptConflictError extends PaidEffectProtocolError {
  override name = 'PaidEffectReceiptConflictError';
}

export class PaidEffectApplicationConflictError extends PaidEffectProtocolError {
  override name = 'PaidEffectApplicationConflictError';
}

export class PaidEffectDeliveryConflictError extends PaidEffectProtocolError {
  override name = 'PaidEffectDeliveryConflictError';
}

/** A delivery was fenced by backend control before any paid work started. */
export class PaidEffectControlFencedError extends PaidEffectProtocolError {
  override name = 'PaidEffectControlFencedError';
  constructor(
    readonly family: string,
    readonly reason: 'backend_mismatch' | 'stale_generation' | 'missing_generation',
    readonly owner: PaidEffectBackend,
  ) {
    super(`paid-effect delivery fenced for ${family}: ${reason} (owner: ${owner})`);
  }
}

export class PaidEffectSwitchBlockedError extends PaidEffectProtocolError {
  override name = 'PaidEffectSwitchBlockedError';
  constructor(
    readonly family: string,
    readonly blocking: {
      readonly pending: number;
      readonly sending: number;
      readonly unknown: number;
      readonly receipt_ready: number;
    },
  ) {
    super(
      `paid-effect backend switch blocked for ${family}: ` +
        `${blocking.pending} pending, ${blocking.sending} sending, ` +
        `${blocking.unknown} unknown, ${blocking.receipt_ready} receipt_ready obligations`,
    );
  }
}

/**
 * TEMPORARY safety guard (P1-R2-2): switching a family whose paid authority
 * lives outside paid_effect is refused until claim-side atomic admission AND
 * persisted producer dispatch generations are wired. note_verify's current
 * handler and DBOS candidate pass no generation. Keep cutover closed until
 * the parent integrates and proves both producer/consumer contracts.
 */
export const PAID_EFFECT_SWITCH_UNSUPPORTED_FAMILIES: readonly string[] = ['note_verify'];

export class PaidEffectSwitchUnsupportedError extends PaidEffectProtocolError {
  override name = 'PaidEffectSwitchUnsupportedError';
  constructor(readonly family: string) {
    super(
      `paid-effect backend switch unsupported for ${family}: ` +
        'atomic admission and versioned dispatch are not both ready; refusing to move ownership',
    );
  }
}

function canonicalValue(value: unknown, path: string): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isFinite(value)) {
        throw new PaidEffectProtocolError(
          `non-finite number at ${path} cannot be canonicalized for a paid-effect digest`,
        );
      }
      return Object.is(value, -0) ? 0 : value;
    case 'bigint':
    case 'symbol':
    case 'function':
    case 'undefined':
      throw new PaidEffectProtocolError(
        `${typeof value} at ${path} cannot be canonicalized for a paid-effect digest`,
      );
    case 'object':
      break;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => canonicalValue(item, `${path}[${index}]`));
  }
  const tag = Object.prototype.toString.call(value);
  if (tag !== '[object Object]') {
    throw new PaidEffectProtocolError(
      `${tag} at ${path} cannot be canonicalized for a paid-effect digest`,
    );
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const entries: [string, unknown][] = [];
  for (const key of keys) {
    const item = record[key];
    if (item === undefined) {
      throw new PaidEffectProtocolError(
        `undefined property "${key}" at ${path} would silently drift the paid-effect digest`,
      );
    }
    entries.push([key, canonicalValue(item, `${path}.${key}`)]);
  }
  return Object.fromEntries(entries);
}

/**
 * Deterministic JSON for digesting: object keys sorted recursively, array
 * order preserved, -0 normalized, and every lossy-to-JSON value rejected.
 */
export function canonicalizePaidEffectJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value, '$'));
}

/** Semantic equality of two JSON documents under the same canonicalization. */
export function paidEffectJsonEquals(a: unknown, b: unknown): boolean {
  try {
    return canonicalizePaidEffectJson(a) === canonicalizePaidEffectJson(b);
  } catch {
    return false;
  }
}

export function computePaidEffectInputDigest(input: unknown): string {
  const canonical = canonicalizePaidEffectJson(input);
  return `${PAID_EFFECT_DIGEST_PREFIX}${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

function requireIdentityString(value: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PaidEffectProtocolError(`paid-effect ${field} must be a non-empty string`);
  }
  return value;
}

export function computePaidEffectIdentity(input: PaidEffectInput): PaidEffectIdentity {
  const family = requireIdentityString(input.family, 'family');
  const entityId = requireIdentityString(input.entityId, 'entityId');
  const entityRevision = requireIdentityString(input.entityRevision, 'entityRevision');
  const unit = requireIdentityString(input.unit, 'unit');
  return {
    family,
    entityId,
    entityRevision,
    unit,
    inputDigest: computePaidEffectInputDigest(input.input),
  };
}

/**
 * Pure admission decision over a control snapshot. The store/DB layer only
 * supplies the locked snapshot; every rule lives here so it is testable
 * offline and identical for both backends. Both backends require the original
 * dispatch generation after bootstrap. Only pg-boss generation 0 admits old
 * unversioned calls, including a materialized bootstrap control row.
 */
export function decidePaidEffectControlAdmission(
  control: PaidEffectControlSnapshot,
  ref: PaidEffectDeliveryRef,
): PaidEffectControlAdmission {
  const fenced = (
    reason: 'backend_mismatch' | 'stale_generation' | 'missing_generation',
  ): PaidEffectControlAdmission => ({
    kind: 'fenced',
    reason,
    owner: control.backend,
    generation: control.generation,
  });
  if (ref.backend !== control.backend) return fenced('backend_mismatch');
  const bootstrap =
    control.backend === DEFAULT_PAID_EFFECT_BACKEND &&
    control.generation === DEFAULT_PAID_EFFECT_GENERATION;
  if (!bootstrap && ref.generation == null) {
    return fenced('missing_generation');
  }
  if (ref.generation != null && ref.generation !== control.generation) {
    return fenced('stale_generation');
  }
  return { kind: 'admitted', control };
}

/** Pure switch gate over per-state counts supplied by the DB layer. */
export function summarizePaidEffectSwitchBlocking(
  countsByState: {
    readonly [state in PaidEffectState]?: number;
  },
): {
  blocked: boolean;
  blocking: {
    pending: number;
    sending: number;
    unknown: number;
    receipt_ready: number;
  };
} {
  const pending = countsByState.pending ?? 0;
  const sending = countsByState.sending ?? 0;
  const unknown = countsByState.unknown ?? 0;
  const receiptReady = countsByState.receipt_ready ?? 0;
  return {
    blocked: pending + sending + unknown + receiptReady > 0,
    blocking: { pending, sending, unknown, receipt_ready: receiptReady },
  };
}

/**
 * The reserve discrimination — the ONLY send admission verdict. Computed from
 * the locked own row plus the entity-gate scan; pinned so consumers (A/C)
 * never build their own shared-state interpretation:
 * - 'winner': this delivery owns the physical send (pending → sending CAS won).
 * - 'held': do not send — the effect is in flight/unresolved itself, or the
 *   entity gate found another open 'sending'/'unknown' effect for the same
 *   (family, entityId) (blockedBy names it). The obligation stays readable.
 * - 'completed': the paid work is done — an immutable receipt exists; replay
 *   the application from it (applied=true when the application receipt is
 *   already recorded).
 */
export type PaidEffectReservation =
  | { readonly kind: 'winner'; readonly fence: number }
  | {
      readonly kind: 'held';
      readonly state: PaidEffectState;
      readonly blockedBy: PaidEffectIdentity | null;
    }
  | {
      readonly kind: 'completed';
      readonly state: 'receipt_ready' | 'applied';
      readonly result: unknown;
      readonly application: unknown;
      readonly applied: boolean;
    };
