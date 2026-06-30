// Phase 1c.1 Step 9.A — single-owner of `material_fsrs_state` (ADR-0005).
//
// Per ADR-0005 / data-assumptions: `material_fsrs_state` is the FSRS projection
// of `event(action='review', subject_kind=<material kind>)`. The latest review
// event for a (subject_kind, subject_id) drives a single row in this table.
//
// This module is the only allowed writer in `src/server/` and `app/` of this
// table outside the Step 3 migration script. The Step 9.L invariant audit
// enforces this.

import { and, eq, inArray } from 'drizzle-orm';

import { newId } from '@/core/ids';
import type { FsrsStateSchemaT } from '@/core/schema/event/blocks';
import type { Db, Tx } from '@/db/client';
import { material_fsrs_state } from '@/db/schema';

type DbLike = Db | Tx;
export type FsrsSubjectKind = 'question' | 'knowledge';

export interface UpsertFsrsStateInput {
  subject_kind: FsrsSubjectKind;
  subject_id: string;
  state: FsrsStateSchemaT;
  due_at: Date;
  /**
   * Review event id that produced this state — back-reference for audit / replay.
   * Nullable (the column is nullable): a snapshot revert restores a Card whose prior
   * review event id is unknown (YUK-471 W0 restore-snapshot) → null = "unknown prior".
   */
  last_review_event_id: string | null;
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
  subject_kind: FsrsSubjectKind,
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

/**
 * A5 S3 (YUK-354) — batched read of the FSRS state projection for many
 * (subject_kind, subject_id) pairs in one round-trip. Mirrors {@link getFsrsState}
 * but for a set of ids; absent ids are simply missing from the returned Map (the
 * caller treats "no row" as "no retrievability data yet", NOT R=0).
 *
 * SoT read only — this stays the single-owner module for `material_fsrs_state`.
 * It never computes retrievability (no ts-fsrs dependency here); the per-KC
 * R(t) ∈ [0,1] mapping lives in the knowledge-capability read that consumes this
 * (retrievabilityForKc is a practice-capability pure function — keeping it out of
 * src/server avoids a server→capability layering inversion).
 */
export async function getFsrsStatesByIds(
  db: DbLike,
  subject_kind: FsrsSubjectKind,
  subject_ids: string[],
): Promise<Map<string, FsrsStateRow>> {
  const ids = Array.from(new Set(subject_ids.map((id) => id.trim()).filter((id) => id.length > 0)));
  if (ids.length === 0) return new Map();
  const rows = await db
    .select()
    .from(material_fsrs_state)
    .where(
      and(
        eq(material_fsrs_state.subject_kind, subject_kind),
        inArray(material_fsrs_state.subject_id, ids),
      ),
    );
  return new Map(
    rows.map((row) => [
      row.subject_id,
      {
        subject_kind: row.subject_kind,
        subject_id: row.subject_id,
        state: row.state as FsrsStateSchemaT,
        due_at: row.due_at,
        last_review_event_id: row.last_review_event_id ?? null,
      },
    ]),
  );
}
