// Generative-UI drawing: durable Sol background draws. One row is one drawing
// generation-line — learner-visible output + provenance, not transient worker
// state (losing it on restore would orphan the placed `block:` refs in the
// conversation). No enforced FKs: session/task-run/event/asset ids are loose
// text refs, matching project convention.
//
//   queued ──claim──▶ running ──success──▶ ready
//      ▲                 │                  │
//      │                 ├─quota──▶ waiting_quota ─┐
//      │                 ├─login──▶ waiting_login ─┤ delayed retry job
//      └──◀──────────────┘   └─fail─▶ failed       │
//   redraw moves ready/failed/cancelled/expired → queued (attempt+1,
//   keep last_ready_*); cancel fences live states → cancelled; expiry
//   and source retraction fence → expired (derived asset never served).
// Every transition is a CAS guarded by `version`.

import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// Status sets live in the owning capability (server/drawing-state.ts) — the
// architecture rule only lets schema.ts forward real pgTable symbols, so this
// column type is declared literally here and the arrays derive from it there.
export type DrawingStatus =
  | 'queued'
  | 'running'
  | 'ready'
  | 'waiting_quota'
  | 'waiting_login'
  | 'failed'
  | 'cancelled'
  | 'expired';

export interface DrawingSourceRef {
  kind: 'document' | 'question' | 'record' | 'event' | 'session';
  id: string;
}

export interface DrawingSourceEpoch {
  document_id: string;
  /** Frozen `source_document.provenance.usage_epoch` string, verbatim. */
  usage_epoch: string;
}

export const drawing = pgTable(
  'drawing',
  {
    id: text('id').primaryKey(),
    /** Learner scope; every read/status path must match it — never token-only. */
    session_id: text('session_id').notNull(),
    /** sha256 of {session_id,brief,alt,caption}; dedupes same-content requests. */
    dedupe_key: text('dedupe_key').notNull(),
    status: text('status').$type<DrawingStatus>().notNull().default('queued'),
    /** CAS fence; every guarded transition increments it. */
    version: integer('version').notNull().default(0),
    /** Generation counter; redraw bumps it (stable id, fresh Sol run). */
    attempt: integer('attempt').notNull().default(1),
    brief: text('brief').notNull(),
    alt: text('alt').notNull(),
    caption: text('caption'),
    /** Authoritative server-bound source set captured at admission. */
    sources: jsonb('sources').$type<DrawingSourceRef[]>().notNull(),
    /** false ⇒ admission proved the read set unbindable; row is audit-only. */
    source_complete: boolean('source_complete').notNull(),
    /** Frozen source_document usage epochs at admission (retraction fence). */
    source_epochs: jsonb('source_epochs').$type<DrawingSourceEpoch[]>().notNull(),
    /** Last SUCCESSFUL result; survives a failed/cancelled redraw. */
    last_ready_asset_id: text('last_ready_asset_id'),
    last_ready_asset_digest: text('last_ready_asset_digest'),
    last_ready_task_run_id: text('last_ready_task_run_id'),
    /** Current generation's Sol run + the requesting Copilot run (audit). */
    sol_task_run_id: text('sol_task_run_id'),
    copilot_task_run_id: text('copilot_task_run_id').notNull(),
    /** The ask/input event this drawing derives from (provenance). */
    source_event_id: text('source_event_id'),
    /**
     * restricted_source | quota | login | provider | config | output |
     * cancelled | retracted | timeout — typed classification, no strings.
     */
    error_kind: text('error_kind'),
    error_detail: text('error_detail'),
    /** waiting_* resume clock; the delayed retry job carries it. */
    retry_at: timestamp('retry_at', { withTimezone: true }),
    /** Hard TTL for the whole wait lifecycle; claim/read fences it. */
    expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('drawing_session_idx').on(t.session_id, t.created_at),
    index('drawing_status_retry_idx')
      .on(t.retry_at)
      .where(sql`${t.status} IN ('waiting_quota','waiting_login')`),
    // Same-content dedupe applies to live generations only; a terminal row
    // (failed/cancelled/expired) frees the key for a fresh line.
    uniqueIndex('drawing_dedupe_live_idx')
      .on(t.dedupe_key)
      .where(sql`${t.status} IN ('queued','running','ready','waiting_quota','waiting_login')`),
  ],
);
