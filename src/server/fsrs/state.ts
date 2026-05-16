// Phase 1c.1 Step 9.A — single-owner of `material_fsrs_state` (ADR-0005).
//
// Per ADR-0005 / data-assumptions: `material_fsrs_state` is the FSRS projection
// of `event(action='review', subject_kind=<material kind>)`. The latest review
// event for a (subject_kind, subject_id) drives a single row in this table.
//
// This module is the only allowed writer in `src/server/` and `app/` of this
// table outside the Step 3 migration script. The Step 9.L invariant audit
// enforces this.

import { eq, and } from 'drizzle-orm';

import { newId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import { material_fsrs_state } from '@/db/schema';
import type { FsrsStateSchemaT } from '@/core/schema/event/blocks';

type DbLike = Db | Tx;

export interface UpsertFsrsStateInput {
  subject_kind: 'question';
  subject_id: string;
  state: FsrsStateSchemaT;
  due_at: Date;
  /** review event id that produced this state — back-reference for audit / replay */
  last_review_event_id: string;
}

/**
 * Upsert the FSRS state projection for a (subject_kind, subject_id) pair.
 *
 * The `material_fsrs_unique` index enforces one row per (kind, id) — concurrent
 * review-submit calls race on the index; the loser falls back to UPDATE inside
 * the same statement via ON CONFLICT.
 */
export async function upsertFsrsState(db: DbLike, input: UpsertFsrsStateInput): Promise<void> {
  const now = new Date();
  await db
    .insert(material_fsrs_state)
    .values({
      id: newId(),
      subject_kind: input.subject_kind,
      subject_id: input.subject_id,
      state: input.state,
      due_at: input.due_at,
      last_review_event_id: input.last_review_event_id,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: [material_fsrs_state.subject_kind, material_fsrs_state.subject_id],
      set: {
        state: input.state,
        due_at: input.due_at,
        last_review_event_id: input.last_review_event_id,
        updated_at: now,
      },
    });
}

export interface FsrsStateRow {
  subject_kind: string;
  subject_id: string;
  state: FsrsStateSchemaT;
  due_at: Date;
  last_review_event_id: string | null;
}

/**
 * Read the latest FSRS state row for a (subject_kind, subject_id) pair, or null.
 */
export async function getFsrsState(
  db: DbLike,
  subject_kind: 'question',
  subject_id: string,
): Promise<FsrsStateRow | null> {
  const rows = await db
    .select()
    .from(material_fsrs_state)
    .where(
      and(
        eq(material_fsrs_state.subject_kind, subject_kind),
        eq(material_fsrs_state.subject_id, subject_id),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    subject_kind: row.subject_kind,
    subject_id: row.subject_id,
    state: row.state as FsrsStateSchemaT,
    due_at: row.due_at,
    last_review_event_id: row.last_review_event_id ?? null,
  };
}
