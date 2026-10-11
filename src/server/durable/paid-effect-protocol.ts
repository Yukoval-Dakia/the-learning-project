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
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** States that make a paid effect an unresolved obligation for readers. */
export const PAID_EFFECT_OBLIGATION_STATES = [
  'pending',
  'sending',
  'unknown',
  'receipt_ready',
] as const satisfies readonly PaidEffectState[];

/**
 * States that block a backend switch. `pending` has not crossed the paid
 * boundary (either backend may claim it via the row CAS), `receipt_ready` can
 * finish its application from the immutable receipt on either backend;
 * `sending`/`unknown` mean a physical send is in flight or its outcome is
 * unresolved, so ownership must not move underneath them.
 */
export const PAID_EFFECT_SWITCH_BLOCKING_STATES = [
  'sending',
  'unknown',
] as const satisfies readonly PaidEffectState[];

/**
 * Entity gate: a send claim for one identity is refused while ANOTHER effect
 * of the same (family, entityId) is 'sending'/'unknown'. This is what makes a
 * cross-night / cross-workset re-selection of the same business entity block
 * on its open paid obligation even though the new workset mints a NEW identity
 * (e.g. a later frozen workSetId): the provider may already have been engaged
 * for that entity, so no new physical send may start until the obligation is
 * resolved. 'pending' does NOT gate cross-identity — no paid boundary has
 * been crossed and the pending row itself stays claimable.
 */
export const PAID_EFFECT_ENTITY_GATE_STATES = [
  'sending',
  'unknown',
] as const satisfies readonly PaidEffectState[];

/**
 * Entity-gate scope — a PINNED per-family protocol option (consumers pass a
 * constant, they never build their own gate):
 * - 'entity' (default): a send is refused while ANY effect of the same
 *   (family, entityId) is sending/unknown. Timed/calibration semantics — a
 *   later workset (new workSetId) or revision must not buy while the entity
 *   has an open paid obligation.
 * - 'entity-revision': a send is refused only within
 *   (family, entityId, entityRevision). Per-rep semantics — sibling units of
 *   ONE revision are deliberately parallel paid sends and must not block each
 *   other; a NEW revision is still blocked by the old revision's unknown,
 *   forcing explicit reconciliation before re-deriving.
 */
export const PAID_EFFECT_GATE_SCOPES = ['entity', 'entity-revision'] as const;
export type PaidEffectGateScope = (typeof PAID_EFFECT_GATE_SCOPES)[number];
export const DEFAULT_PAID_EFFECT_GATE_SCOPE: PaidEffectGateScope = 'entity';

export const paidEffectIdentitySchema = z.strictObject({
  family: z.string().min(1),
  entityId: z.string().min(1),
  /** Free-form revision coordinate (artifact version, frozen workSetId, …). */
  entityRevision: z.string().min(1),
  unit: z.string().min(1),
  inputDigest: z.string().regex(new RegExp(`^${PAID_EFFECT_DIGEST_PREFIX}${SHA256_HEX.source}$`)),
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
  /** Control generation observed at dispatch; stale generations are fenced. */
  readonly generation?: number | null;
}

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
      readonly reason: 'backend_mismatch' | 'stale_generation';
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
    readonly reason: 'backend_mismatch' | 'stale_generation',
    readonly owner: PaidEffectBackend,
  ) {
    super(`paid-effect delivery fenced for ${family}: ${reason} (owner: ${owner})`);
  }
}

export class PaidEffectSwitchBlockedError extends PaidEffectProtocolError {
  override name = 'PaidEffectSwitchBlockedError';
  constructor(
    readonly family: string,
    readonly blocking: { readonly sending: number; readonly unknown: number },
  ) {
    super(
      `paid-effect backend switch blocked for ${family}: ` +
        `${blocking.sending} sending, ${blocking.unknown} unknown obligations`,
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
 * offline and identical for both backends.
 */
export function decidePaidEffectControlAdmission(
  control: PaidEffectControlSnapshot,
  ref: PaidEffectDeliveryRef,
): PaidEffectControlAdmission {
  const fenced = (reason: 'backend_mismatch' | 'stale_generation'): PaidEffectControlAdmission => ({
    kind: 'fenced',
    reason,
    owner: control.backend,
    generation: control.generation,
  });
  if (!control.explicit) {
    // Bootstrap default: pg-boss owns generation 0; DBOS never default-admits.
    return ref.backend === DEFAULT_PAID_EFFECT_BACKEND
      ? { kind: 'admitted', control }
      : fenced('backend_mismatch');
  }
  if (ref.backend !== control.backend) return fenced('backend_mismatch');
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
): { blocked: boolean; blocking: { sending: number; unknown: number } } {
  const sending = countsByState.sending ?? 0;
  const unknown = countsByState.unknown ?? 0;
  return { blocked: sending + unknown > 0, blocking: { sending, unknown } };
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
