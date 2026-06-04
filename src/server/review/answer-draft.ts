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

import { and, eq, isNull, sql } from 'drizzle-orm';

import { newId } from '@/core/ids';
import type { Db, Tx } from '@/db/client';
import { answer } from '@/db/schema';

type DbLike = Db | Tx;

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
 * @returns the id of the live draft row.
 */
export async function autosaveAnswerDraft(
  db: DbLike,
  input: AutosaveAnswerDraftInput,
): Promise<{ answerId: string }> {
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
    await db
      .update(answer)
      .set({
        input_kind: input.inputKind,
        content_md: input.contentMd,
        image_refs: input.imageRefs ?? [],
        paper_artifact_id: input.paperArtifactId ?? null,
        autosaved_at: now,
      })
      .where(eq(answer.id, existing[0].id));
    return { answerId: existing[0].id };
  }

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
    await db
      .update(answer)
      .set({
        input_kind: input.inputKind,
        content_md: input.contentMd,
        image_refs: input.imageRefs ?? [],
        paper_artifact_id: input.paperArtifactId ?? null,
        submitted_at: submittedAt,
        event_id: input.eventId,
      })
      .where(eq(answer.id, existing[0].id));
    return { answerId: existing[0].id };
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
