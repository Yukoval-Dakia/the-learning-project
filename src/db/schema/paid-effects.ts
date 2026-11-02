// Paid effects: durable effect rows, the control fence, authorizations, and
// cancellations.

import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

// YUK-1355 Lane B — shared durable paid-effect protocol (fixed interface in
// src/core/migration/paid-effect-protocol.ts; semantics + parent-owned SQL
// draft in docs/planning/2026-10-11-yuk1355-paid-effect-protocol.md).
// paid_effect_control: family-scoped backend ownership. ABSENCE of a row is
// meaningful — it is the bootstrap default owner (pg-boss, generation 0), so
// paid_effect.family deliberately has NO FK here.
export const paid_effect_control = pgTable('paid_effect_control', {
  family: text('family').primaryKey(),
  backend: text('backend')
    .$type<import('../../core/migration/paid-effect-protocol').PaidEffectBackend>()
    .notNull(),
  generation: integer('generation').notNull().default(0),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// YUK-1355 Lane B — one immutable row per paid-effect identity
// (family, entity_id, entity_revision, unit, input_digest). Delivery identity
// (delivery_id/tick) is audit metadata on the admitted send, never part of the
// key; identity columns are never updated and rows are never deleted. State
// machine: pending → sending → (unknown | receipt_ready) → applied, with no
// path back to pending and no auto-replay from unknown. YUK-1567 adds
// unknown → voided: a lead-authorized terminal resolution that preserves every
// evidence column and carries a void receipt (voided_at + void_json). The same
// ticket also adds pending → cancelled: a lead-authorized retirement of a
// never-sent intent (cancelled_at + cancel_json) — no successor, no re-spend.
export const paid_effect = pgTable(
  'paid_effect',
  {
    family: text('family').notNull(),
    entity_id: text('entity_id').notNull(),
    // Free-form revision coordinate (artifact version string, frozen workSetId,
    // …) — text, not integer, because scheduled families key on workset ids.
    entity_revision: text('entity_revision').notNull(),
    unit: text('unit').notNull(),
    input_digest: text('input_digest').notNull(),
    input_json: jsonb('input_json').notNull(),
    state: text('state')
      .$type<import('../../core/migration/paid-effect-protocol').PaidEffectState>()
      .notNull(),
    fence: integer('fence').notNull().default(0),
    delivery_id: text('delivery_id'),
    delivery_backend:
      text('delivery_backend').$type<
        import('../../core/migration/paid-effect-protocol').PaidEffectBackend
      >(),
    delivery_tick: text('delivery_tick'),
    send_lease_expires_at: timestamp('send_lease_expires_at', { withTimezone: true }),
    result_json: jsonb('result_json'),
    result_recorded_at: timestamp('result_recorded_at', { withTimezone: true }),
    application_json: jsonb('application_json'),
    applied_at: timestamp('applied_at', { withTimezone: true }),
    application_attempts: integer('application_attempts').notNull().default(0),
    last_application_error: text('last_application_error'),
    unresolved_reason: text('unresolved_reason'),
    voided_at: timestamp('voided_at', { withTimezone: true }),
    void_json: jsonb('void_json'),
    cancelled_at: timestamp('cancelled_at', { withTimezone: true }),
    cancel_json: jsonb('cancel_json'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.family, t.entity_id, t.entity_revision, t.unit, t.input_digest] }),
    index('paid_effect_obligation_idx').on(t.family, t.state),
    check(
      'paid_effect_state_ck',
      sql`${t.state} IN ('pending','sending','unknown','receipt_ready','applied','voided','cancelled')`,
    ),
    check('paid_effect_digest_ck', sql`${t.input_digest} ~ '^sha256:[0-9a-f]{64}$'`),
    check('paid_effect_fence_ck', sql`${t.fence} >= 0`),
    check(
      'paid_effect_identity_nonempty_ck',
      sql`${t.entity_id} <> '' AND ${t.entity_revision} <> '' AND ${t.unit} <> ''`,
    ),
    check(
      'paid_effect_state_shape_ck',
      sql`(
        (${t.state} = 'pending' AND ${t.delivery_id} IS NULL AND ${t.delivery_backend} IS NULL AND ${t.send_lease_expires_at} IS NULL AND ${t.result_json} IS NULL AND ${t.applied_at} IS NULL)
        OR (${t.state} = 'sending' AND ${t.delivery_id} IS NOT NULL AND ${t.delivery_backend} IS NOT NULL AND ${t.send_lease_expires_at} IS NOT NULL AND ${t.result_json} IS NULL AND ${t.applied_at} IS NULL)
        OR (${t.state} = 'unknown' AND ${t.delivery_id} IS NOT NULL AND ${t.delivery_backend} IS NOT NULL AND ${t.send_lease_expires_at} IS NULL AND ${t.result_json} IS NULL AND ${t.applied_at} IS NULL AND ${t.unresolved_reason} IS NOT NULL)
        OR (${t.state} = 'receipt_ready' AND ${t.result_json} IS NOT NULL AND ${t.result_recorded_at} IS NOT NULL AND ${t.send_lease_expires_at} IS NULL AND ${t.applied_at} IS NULL)
        OR (${t.state} = 'applied' AND ${t.result_json} IS NOT NULL AND ${t.applied_at} IS NOT NULL AND ${t.application_json} IS NOT NULL AND ${t.send_lease_expires_at} IS NULL)
        OR (${t.state} = 'voided' AND ${t.delivery_id} IS NOT NULL AND ${t.delivery_backend} IS NOT NULL AND ${t.unresolved_reason} IS NOT NULL AND ${t.send_lease_expires_at} IS NULL AND ${t.result_json} IS NULL AND ${t.applied_at} IS NULL AND ${t.voided_at} IS NOT NULL AND ${t.void_json} IS NOT NULL)
        OR (${t.state} = 'cancelled' AND ${t.delivery_id} IS NULL AND ${t.delivery_backend} IS NULL AND ${t.delivery_tick} IS NULL AND ${t.send_lease_expires_at} IS NULL AND ${t.result_json} IS NULL AND ${t.result_recorded_at} IS NULL AND ${t.application_json} IS NULL AND ${t.applied_at} IS NULL AND ${t.unresolved_reason} IS NULL AND ${t.voided_at} IS NULL AND ${t.void_json} IS NULL AND ${t.cancelled_at} IS NOT NULL AND ${t.cancel_json} IS NOT NULL)
      )`,
    ),
    check('paid_effect_application_attempts_ck', sql`${t.application_attempts} >= 0`),
  ],
);

// YUK-1567 — one durable authorization row per voided paid effect (PK = the
// voided identity, so a row can be void-authorized at most once). Several
// voided rows may share one authorization_id when a single decision retires
// multiple old blockers in favor of ONE successor; the successor delivery
// binding is what makes the named successor send consumable by exactly one
// delivery and no other. consumed_at/consumed_delivery_id record the claim
// that spent the authorization (audit; once-only is the pending→sending CAS).
export const paid_effect_authorization = pgTable(
  'paid_effect_authorization',
  {
    family: text('family').notNull(),
    entity_id: text('entity_id').notNull(),
    entity_revision: text('entity_revision').notNull(),
    unit: text('unit').notNull(),
    input_digest: text('input_digest').notNull(),
    authorization_id: text('authorization_id').notNull(),
    successor_entity_revision: text('successor_entity_revision').notNull(),
    successor_unit: text('successor_unit').notNull(),
    successor_input_digest: text('successor_input_digest').notNull(),
    successor_delivery_backend: text('successor_delivery_backend')
      .$type<import('../../core/migration/paid-effect-protocol').PaidEffectBackend>()
      .notNull(),
    successor_delivery_id: text('successor_delivery_id').notNull(),
    reason: text('reason').notNull(),
    operator: text('operator').notNull(),
    basis: text('basis').notNull(),
    consumed_delivery_id: text('consumed_delivery_id'),
    consumed_at: timestamp('consumed_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      columns: [t.family, t.entity_id, t.entity_revision, t.unit, t.input_digest],
      // Explicit short names: the auto-derived PK/FK names both truncate to the
      // same 63-byte identifier and collide on ADD CONSTRAINT.
      name: 'paid_effect_authorization_pk',
    }),
    index('paid_effect_authorization_entity_idx').on(t.family, t.entity_id),
    index('paid_effect_authorization_successor_idx').on(
      t.family,
      t.entity_id,
      t.successor_entity_revision,
      t.successor_unit,
      t.successor_input_digest,
    ),
    check(
      'paid_effect_authorization_digest_ck',
      sql`${t.input_digest} ~ '^sha256:[0-9a-f]{64}$' AND ${t.successor_input_digest} ~ '^sha256:[0-9a-f]{64}$'`,
    ),
    check(
      'paid_effect_authorization_nonempty_ck',
      sql`${t.entity_id} <> '' AND ${t.entity_revision} <> '' AND ${t.unit} <> '' AND ${t.authorization_id} <> '' AND ${t.successor_entity_revision} <> '' AND ${t.successor_unit} <> '' AND ${t.successor_delivery_id} <> '' AND ${t.reason} <> '' AND ${t.operator} <> '' AND ${t.basis} <> ''`,
    ),
    foreignKey({
      columns: [t.family, t.entity_id, t.entity_revision, t.unit, t.input_digest],
      name: 'paid_effect_authorization_old_effect_fk',
      foreignColumns: [
        paid_effect.family,
        paid_effect.entity_id,
        paid_effect.entity_revision,
        paid_effect.unit,
        paid_effect.input_digest,
      ],
    }),
  ],
);

// YUK-1567 — one durable cancellation EVENT row per cancelled paid effect
// (PK = the cancelled identity, so an identity can be cancelled at most once;
// a second event under a different request_id can never be minted). Several
// cancelled rows may share one request_id when a single approved operation
// retires a batch of never-sent intents. The row is audit truth written in
// the SAME transaction as the paid_effect pending → cancelled CAS — an event
// failure rolls the state transition back with it. Unlike
// paid_effect_authorization it binds no successor: cancel authorizes nothing.
export const paid_effect_cancellation = pgTable(
  'paid_effect_cancellation',
  {
    family: text('family').notNull(),
    entity_id: text('entity_id').notNull(),
    entity_revision: text('entity_revision').notNull(),
    unit: text('unit').notNull(),
    input_digest: text('input_digest').notNull(),
    request_id: text('request_id').notNull(),
    reason: text('reason').notNull(),
    operator: text('operator').notNull(),
    basis: text('basis').notNull(),
    cancelled_from_state: text('cancelled_from_state').notNull(),
    previous_fence: integer('previous_fence').notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({
      columns: [t.family, t.entity_id, t.entity_revision, t.unit, t.input_digest],
      // Explicit short name so ADD CONSTRAINT never truncates-collides (same
      // 63-byte identifier discipline as the authorization table).
      name: 'paid_effect_cancellation_pk',
    }),
    index('paid_effect_cancellation_entity_idx').on(t.family, t.entity_id),
    index('paid_effect_cancellation_request_idx').on(t.request_id),
    check('paid_effect_cancellation_digest_ck', sql`${t.input_digest} ~ '^sha256:[0-9a-f]{64}$'`),
    check(
      'paid_effect_cancellation_nonempty_ck',
      sql`${t.entity_id} <> '' AND ${t.entity_revision} <> '' AND ${t.unit} <> '' AND ${t.request_id} <> '' AND ${t.reason} <> '' AND ${t.operator} <> '' AND ${t.basis} <> ''`,
    ),
    check(
      'paid_effect_cancellation_from_ck',
      // The never-sent contract is literal: only a fence-0 pending intent may
      // be cancelled — any advanced fence implies a claim touched the row.
      sql`${t.cancelled_from_state} = 'pending' AND ${t.previous_fence} = 0`,
    ),
    foreignKey({
      columns: [t.family, t.entity_id, t.entity_revision, t.unit, t.input_digest],
      name: 'paid_effect_cancellation_old_effect_fk',
      foreignColumns: [
        paid_effect.family,
        paid_effect.entity_id,
        paid_effect.entity_revision,
        paid_effect.unit,
        paid_effect.input_digest,
      ],
    }),
  ],
);
