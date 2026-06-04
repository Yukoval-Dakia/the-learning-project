// U5 (YUK-203) — paper answer-sheet draft layer over the revived `answer` table.
//
// Per-slot grain (Q5): a slot is (session_id, question_id, part_ref). A
// composite question with parts gets one row per part; atomic questions have
// part_ref=null. The partial unique index `answer_draft_slot_uk`
// (session_id, question_id, COALESCE(part_ref,'')) WHERE submitted_at IS NULL
// guarantees ONE live draft per slot.
//
// Lifecycle: autosave (upsert the live draft) → freeze (set submitted_at +
// event_id at submit). Frozen rows are APPEND-ONLY history (§4.5): re-submission
// after abandon→reopen writes a NEW draft + a NEW frozen row; a frozen row is
// never mutated or deleted. This is why `pos` (§4.10 Q9) is COUNT(DISTINCT slot)
// over submitted rows, not a raw COUNT.
//
// Session binding: autosave and freeze REQUIRE the session to be a review session
// bound to the paper artifact AND in a mutable state (started/paused). This is
// validated by assertSessionMutable before any write path executes.

import { and, eq, isNull, sql } from 'drizzle-orm';

import { newId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import { answer, learning_session } from '@/db/schema';
import { ApiError } from '@/server/http/errors';

type DbLike = Db | Tx;

// Postgres unique-violation error code.
const PG_UNIQUE_VIOLATION = '23505';

function isPgUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === PG_UNIQUE_VIOLATION
  );
}

export interface AnswerSlot {
  sessionId: string;
  questionId: string;
  /** StructuredQuestion.id of the part; null/undefined for atomic questions. */
  partRef?: string | null;
}

export interface AutosaveAnswerDraftInput extends AnswerSlot {
  inputKind: string;
  contentMd: string;
  imageRefs?: string[];
  paperArtifactId?: string | null;
}

/**
 * Validate that a session exists, is type='review', is bound to the given paper,
 * and is in a mutable state (started or paused). Throws ApiError(400) on any
 * mismatch so the caller surfaces a client-facing 400 rather than silently
 * writing to the wrong paper or a completed/abandoned session.
 *
 * Shared by autosaveAnswerDraft and (via paper-submit) freezeAnswerDraft.
 */
export async function assertSessionMutable(
  db: DbLike,
  sessionId: string,
  paperArtifactId: string,
): Promise<void> {
  const rows = await db
    .select({
      type: learning_session.type,
      status: learning_session.status,
      artifact_id: learning_session.artifact_id,
    })
    .from(learning_session)
    .where(eq(learning_session.id, sessionId))
    .limit(1);
  const sess = rows[0];
  if (!sess) {
    throw new ApiError('validation_error', `session ${sessionId} not found`, 400);
  }
  if (sess.type !== 'review') {
    throw new ApiError('validation_error', `session ${sessionId} is not a review session`, 400);
  }
  if (sess.artifact_id !== paperArtifactId) {
    throw new ApiError(
      'validation_error',
      `session ${sessionId} is not bound to paper ${paperArtifactId}`,
      400,
    );
  }
  if (sess.status !== 'started' && sess.status !== 'paused') {
    throw new ApiError(
      'validation_error',
      `session ${sessionId} is in status '${sess.status}' and cannot accept answers`,
      400,
    );
  }
}

/**
 * Upsert the single live draft for a slot. Re-saving the same slot UPDATEs the
 * live draft in place (it has submitted_at IS NULL, so it's the only row the
 * partial unique index sees for this slot) — no duplicate draft rows.
 *
 * Implemented as a guarded UPDATE-then-INSERT rather than ON CONFLICT because
 * the conflict target is a PARTIAL expression index; the explicit path is
 * clearer and avoids inference-predicate quirks. Callers should run this inside
 * a transaction with a per-slot advisory lock if concurrent autosaves on the
 * same slot are possible (the answering page is UI-sequential per slot, §4.6
 * Q6, so contention is bounded in practice).
 *
 * Concurrency safety:
 *   UPDATE is scoped with `isNull(submitted_at)` so a race where a concurrent
 *   freeze commits between SELECT and UPDATE results in 0 rows affected (the
 *   frozen row is not touched). In that case we return the frozen row's id (the
 *   slot was already submitted) — the autosave is a no-op, which is correct.
 *   On INSERT, a concurrent first-autosave that committed between SELECT and
 *   INSERT raises 23505; we catch it and re-read the live draft.
 *
 * @returns the id of the live draft row.
 */
export async function autosaveAnswerDraft(
  db: DbLike,
  input: AutosaveAnswerDraftInput,
): Promise<{ answerId: string }> {
  // Validate session↔paper binding and mutable status before any write.
  if (input.paperArtifactId) {
    await assertSessionMutable(db, input.sessionId, input.paperArtifactId);
  }

  const now = new Date();
  const partRef = input.partRef ?? null;

  const existing = await db
    .select({ id: answer.id })
    .from(answer)
    .where(
      and(
        eq(answer.session_id, input.sessionId),
        eq(answer.question_id, input.questionId),
        // COALESCE(part_ref,'') to match the partial-index slot key.
        sql`COALESCE(${answer.part_ref}, '') = COALESCE(${partRef}, '')`,
        isNull(answer.submitted_at),
      ),
    )
    .limit(1);

  if (existing[0]) {
    // Guard: only update the row when it is still a live draft. If a concurrent
    // freeze committed between the SELECT and here, the UPDATE matches 0 rows
    // (the row now has submitted_at set) — that is correct; the autosave is a
    // no-op for an already-frozen slot.
    await db
      .update(answer)
      .set({
        input_kind: input.inputKind,
        content_md: input.contentMd,
        image_refs: input.imageRefs ?? [],
        paper_artifact_id: input.paperArtifactId ?? null,
        autosaved_at: now,
      })
      .where(and(eq(answer.id, existing[0].id), isNull(answer.submitted_at)));
    return { answerId: existing[0].id };
  }

  // INSERT path: a concurrent first-autosave on the same slot may race here and
  // commit its INSERT between our SELECT (found nothing) and this INSERT, causing
  // a 23505 unique violation on answer_draft_slot_uk. Catch it and re-read the
  // live draft that the concurrent writer committed.
  try {
    const answerId = newId();
    await db.insert(answer).values({
      id: answerId,
      question_id: input.questionId,
      // learning_item_id stays null/unused for paper answers (DEFER per Map §B3).
      learning_item_id: null,
      input_kind: input.inputKind,
      content_md: input.contentMd,
      image_refs: input.imageRefs ?? [],
      tags: [],
      submitted_at: null,
      session_id: input.sessionId,
      paper_artifact_id: input.paperArtifactId ?? null,
      part_ref: partRef,
      event_id: null,
      autosaved_at: now,
    });
    return { answerId };
  } catch (err) {
    if (!isPgUniqueViolation(err)) throw err;
    // Another concurrent autosave won the race — re-read its live draft.
    const winner = await db
      .select({ id: answer.id })
      .from(answer)
      .where(
        and(
          eq(answer.session_id, input.sessionId),
          eq(answer.question_id, input.questionId),
          sql`COALESCE(${answer.part_ref}, '') = COALESCE(${partRef}, '')`,
          isNull(answer.submitted_at),
        ),
      )
      .limit(1);
    if (!winner[0]) {
      // Extremely unlikely: the winner was already frozen before we could re-read.
      // Re-throw the original error so the caller can handle the conflict.
      throw err;
    }
    return { answerId: winner[0].id };
  }
}

export interface FreezeAnswerDraftInput extends AnswerSlot {
  /** the attempt event id this freeze is bound to (back-ref for audit) */
  eventId: string;
  submittedAt?: Date;
}

/**
 * Freeze the live draft for a slot: set submitted_at + event_id. After this the
 * row leaves the partial unique index (submitted_at IS NOT NULL), so a fresh
 * autosave on the same slot (e.g. after abandon→reopen) creates a NEW live
 * draft without colliding. The frozen row is never mutated again (append-only).
 *
 * If no live draft exists for the slot (the user submitted without an autosave
 * round-trip), an already-frozen row is inserted directly so the answer-sheet
 * history is complete.
 *
 * Concurrency safety:
 *   UPDATE is scoped with `isNull(submitted_at)` so a race where the row was
 *   already frozen by a concurrent request results in 0 rows affected. In that
 *   case we re-read the existing frozen row and return its id (idempotent freeze
 *   — the concurrent freeze won, which is correct for the append-only model).
 *
 * @returns the id of the frozen row.
 */
export async function freezeAnswerDraft(
  db: DbLike,
  input: FreezeAnswerDraftInput & {
    inputKind: string;
    contentMd: string;
    imageRefs?: string[];
    paperArtifactId?: string | null;
  },
): Promise<{ answerId: string }> {
  const submittedAt = input.submittedAt ?? new Date();
  const partRef = input.partRef ?? null;

  const existing = await db
    .select({ id: answer.id })
    .from(answer)
    .where(
      and(
        eq(answer.session_id, input.sessionId),
        eq(answer.question_id, input.questionId),
        sql`COALESCE(${answer.part_ref}, '') = COALESCE(${partRef}, '')`,
        isNull(answer.submitted_at),
      ),
    )
    .limit(1);

  if (existing[0]) {
    // Guard: only freeze the row when it is still a live draft. A concurrent
    // freeze (e.g. double-submit race) will have already set submitted_at, causing
    // 0 rows affected here. Re-read the slot to confirm the concurrent freeze
    // produced a usable frozen row and return its id (idempotent).
    const updated = await db
      .update(answer)
      .set({
        input_kind: input.inputKind,
        content_md: input.contentMd,
        image_refs: input.imageRefs ?? [],
        paper_artifact_id: input.paperArtifactId ?? null,
        submitted_at: submittedAt,
        event_id: input.eventId,
      })
      .where(and(eq(answer.id, existing[0].id), isNull(answer.submitted_at)))
      .returning({ id: answer.id });

    if (updated[0]) {
      return { answerId: updated[0].id };
    }

    // 0 rows affected: the row was frozen by a concurrent request between SELECT
    // and UPDATE. Re-read the now-frozen row for its id.
    const frozen = await db
      .select({ id: answer.id })
      .from(answer)
      .where(eq(answer.id, existing[0].id))
      .limit(1);
    // frozen[0] must exist (we just read the id above); include a safety fallback.
    return { answerId: frozen[0]?.id ?? existing[0].id };
  }

  const answerId = newId();
  await db.insert(answer).values({
    id: answerId,
    question_id: input.questionId,
    learning_item_id: null,
    input_kind: input.inputKind,
    content_md: input.contentMd,
    image_refs: input.imageRefs ?? [],
    tags: [],
    submitted_at: submittedAt,
    session_id: input.sessionId,
    paper_artifact_id: input.paperArtifactId ?? null,
    part_ref: partRef,
    event_id: input.eventId,
    autosaved_at: null,
  });
  return { answerId };
}

/**
 * Count answered slots for a session: COUNT(DISTINCT (question_id,
 * COALESCE(part_ref,''))) WHERE submitted_at IS NOT NULL (§4.10 Q9). Distinct on
 * slot so a slot submitted, abandon→reopened, and re-submitted (two frozen rows)
 * counts ONCE — a raw row count would render "5/4".
 */
export async function countAnsweredSlots(db: DbLike, sessionId: string): Promise<number> {
  const rows = await db.execute<{ pos: number }>(sql`
    SELECT COUNT(DISTINCT (question_id, COALESCE(part_ref, '')))::int AS pos
    FROM answer
    WHERE session_id = ${sessionId} AND submitted_at IS NOT NULL
  `);
  const arr = rows as unknown as Array<{ pos: number }>;
  return arr[0]?.pos ?? 0;
}
