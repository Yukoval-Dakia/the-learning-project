// Single owner of `material_fsrs_state` (ADR-0005).
//
// The table projects `event(action='review')` for scheduled subjects: the latest review
// event for a (subject_kind, subject_id) drives one row. Only this module writes it.

import { and, eq, inArray } from 'drizzle-orm';

import { newId } from '@/core/ids';
import {
  CandidateStateSchema,
  type SchedulingState,
  SchedulingStateSchema,
  isCandidateState,
} from '@/core/schema/scheduling-state';
import type { Db, Tx } from '@/db/client';
import {
  acquireLearningStateWriteLock,
  acquireSortedAdvisoryLocks,
  withLearningStateLock,
} from '@/db/learning-state-lock';
import { material_fsrs_state } from '@/db/schema';
import { initialCandidateState, projectCandidateDue } from './candidate';
import { type RetentionReading, retrievabilityForKc } from './retention';

export type { RetentionReading } from './retention';

import { selectedForgettingEngine } from './engine-selection';

type DbLike = Db | Tx;
export type FsrsSubjectKind = 'question' | 'knowledge';

/** Resolve one row under the selected engine without writing a second projection. */
export async function resolveSchedulingProjection<T extends { state: unknown; due_at: Date }>(
  db: DbLike,
  kind: FsrsSubjectKind,
  id: string,
  row: T,
  now: Date,
): Promise<T & { state: SchedulingState }> {
  const parsed = SchedulingStateSchema.safeParse(row.state);
  if (
    selectedForgettingEngine() === 'forgetting_candidate' &&
    (!parsed.success || !isCandidateState(parsed.data))
  ) {
    const { candidateStateForRead } = await import('@/server/assessment/settle');
    try {
      const rebuilt = await db.transaction((tx) => candidateStateForRead(tx, { kind, id }, now));
      const state = parsed.success
        ? rebuilt
        : { ...rebuilt, conversion: 'invalid_rebuilt' as const };
      return { ...row, state, due_at: state.due };
    } catch {
      const anchor = new Date(Math.min(row.due_at.getTime(), now.getTime()));
      const cold = initialCandidateState(id, anchor);
      const state = {
        ...cold,
        ...projectCandidateDue(cold, anchor),
        conversion: 'invalid_rebuilt' as const,
        fallbackReason: 'sealed_history_unavailable',
      };
      return { ...row, state, due_at: state.due };
    }
  }
  if (!parsed.success) throw new Error('invalid scheduling state');
  if (
    selectedForgettingEngine() === 'forgetting_candidate' &&
    isCandidateState(parsed.data) &&
    parsed.data.dueKind !== 'initial' &&
    parsed.data.modelDue === undefined
  ) {
    const state = parsed.data;
    // Anchor to the completed occurrence, never the reader's wall clock.
    const anchor = state.last_review ?? new Date(Math.min(state.due.getTime(), now.getTime()));
    const projected = projectCandidateDue(state, anchor);
    return { ...row, state: { ...state, ...projected }, due_at: projected.due };
  }
  return { ...row, state: parsed.data };
}

/** Retention is a state-owner query, not a consumer's reading of stored cards. Missing
 * rows stay absent (unknown), which is not the same as a New card's zero retention. */
export async function getFsrsRetrievabilityByIds(
  db: DbLike,
  subjectKind: FsrsSubjectKind,
  ids: string[],
  now: Date,
): Promise<Map<string, RetentionReading>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select()
    .from(material_fsrs_state)
    .where(
      and(
        eq(material_fsrs_state.subject_kind, subjectKind),
        inArray(material_fsrs_state.subject_id, ids),
      ),
    );
  const values = new Map<string, RetentionReading>();
  for (const raw of rows) {
    try {
      const row = await resolveSchedulingProjection(db, subjectKind, raw.subject_id, raw, now);
      values.set(raw.subject_id, retrievabilityForKc(row.state, now));
    } catch {
      values.set(raw.subject_id, {
        kind: 'unknown',
        reason: 'state_or_history_unavailable',
        calibration: 'uncalibrated',
        provenance: 'engineering',
      });
    }
  }
  return values;
}

import type { UpsertFsrsStateInput } from '@/kernel/records/material-fsrs-state-write';

/** Upsert the projection; the unique index turns a concurrent insert race into an update. */
export async function upsertFsrsState(db: DbLike, input: UpsertFsrsStateInput): Promise<void> {
  await withLearningStateLock(db, async (tx) => {
    const now = new Date();
    await tx
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
  });
}

/**
 * Repair the projection when KC `fromId` is merged into `intoId`.
 *
 * Never merges Card state or recomputes stability/due dates (no invented merge math):
 * absent source → noop, source only → rename, both → freeze and log. Locks both KC keys
 * in the shared `fsrs:knowledge` namespace, sorted, so a concurrent review submit
 * serializes against the merge. Only knowledge rows are KC-keyed; question rows never match.
 */
export async function retireFsrsStateOnMerge(
  tx: Tx,
  fromId: string,
  intoId: string,
): Promise<'noop' | 'renamed' | 'frozen'> {
  // YUK-497 — global learning-state write lock before the per-key locks (shared tx-entry order).
  await acquireLearningStateWriteLock(tx);
  await acquireSortedAdvisoryLocks(tx, 'fsrs:knowledge', [fromId, intoId]);
  const rows = await tx
    .select({ subject_id: material_fsrs_state.subject_id, state: material_fsrs_state.state })
    .from(material_fsrs_state)
    .where(
      and(
        eq(material_fsrs_state.subject_kind, 'knowledge'),
        inArray(material_fsrs_state.subject_id, [fromId, intoId]),
      ),
    );
  const present = new Set(rows.map((r) => r.subject_id));
  if (!present.has(fromId)) return 'noop';
  if (!present.has(intoId)) {
    const source = rows.find((row) => row.subject_id === fromId);
    if (!source) throw new Error('merge source disappeared under lock');
    const state = source.state;
    let renamedState: SchedulingState | undefined;
    if (state && typeof state === 'object' && isCandidateState(state)) {
      const candidate = CandidateStateSchema.parse(state);
      // Validate the candidate without normalizing stored dates or dropping unknown JSON keys.
      renamedState = {
        ...state,
        historySubjectIds: [...new Set([...candidate.historySubjectIds, fromId])],
      };
    }
    await tx
      .update(material_fsrs_state)
      .set({
        subject_id: intoId,
        ...(renamedState ? { state: renamedState } : {}),
        updated_at: new Date(),
      })
      .where(
        and(
          eq(material_fsrs_state.subject_kind, 'knowledge'),
          eq(material_fsrs_state.subject_id, fromId),
        ),
      );
    return 'renamed';
  }
  console.warn(
    '[retireFsrsStateOnMerge] both from+into have material_fsrs_state — freezing from-row (no FSRS merge)',
    { fromId, intoId },
  );
  return 'frozen';
}

export interface FsrsStateRow {
  subject_kind: string;
  subject_id: string;
  state: SchedulingState;
  due_at: Date;
  last_review_event_id: string | null;
}

/** Latest FSRS row for a subject, or null. */
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
    state: SchedulingStateSchema.parse(row.state),
    due_at: row.due_at,
    last_review_event_id: row.last_review_event_id ?? null,
  };
}

/**
 * Batched {@link getFsrsState}. Absent ids are missing from the map, not R=0; consumers
 * that only need retention should use getFsrsRetrievabilityByIds instead.
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
        state: SchedulingStateSchema.parse(row.state),
        due_at: row.due_at,
        last_review_event_id: row.last_review_event_id ?? null,
      },
    ]),
  );
}
