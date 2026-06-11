// YUK-281 (YUK-203) — question-bank WRITE path: edit (PATCH) + archive (DELETE).
//
// Companion to the YUK-280 read aggregator (src/server/questions/detail.ts).
// The question-bank UI editor (题面/选项/答案/难度/知识点/题型/draft_status) and the
// delete flow (association-count warning + confirm) post here.
//
// ── Soft-delete decision (map §YUK-281) ──────────────────────────────────────
// The `question` table has NO `archived_at`/`deleted_at` column. Every pool /
// due / practice / review / fewshot consumer filters questions with the existing
// invariant `(draft_status IS NULL OR draft_status <> 'draft')` (see
// src/server/review/due-list.ts:232, src/server/quiz/fewshot-retrieve.ts:134,
// src/server/ai/tools/context-readers.ts:829, src/server/orchestrator/review.ts:320,
// src/server/quiz/sourcing-sequence.ts:126, …). Therefore the minimal,
// naturally-excluded soft-delete is to set `draft_status='draft'`: the question
// instantly drops out of every consumer with ZERO consumer changes.
//
// We deliberately do NOT introduce a new `draft_status='archived'` value: those
// same filters check `<> 'draft'` (NOT `= 'active'`), so an 'archived' row would
// LEAK back into the pool unless ~10 consumers were edited — over-scoped and
// risky. The archive INTENT (vs an ordinary draft) is preserved as evidence in
// the `experimental:question_archive` event payload AND on the row via
// `metadata.archived_at` / `metadata.archived_reason` (no schema migration).
//
// ── Cascade decision (map §YUK-281) ──────────────────────────────────────────
// A composite "part" is a `question` row tagged `kind='question_part'` linked by
// `parent_question_id` (src/server/questions/parts.ts). Parts are independent
// rows with their own FSRS state — there is NO FK ON DELETE CASCADE anywhere
// (no FK references question.id at all). So archiving a parent must explicitly
// cascade-archive its parts in the SAME transaction, otherwise orphaned parts
// stay live in the pool. Variant-lineage children (root_question_id /
// parent_variant_id) are NOT cascaded — they are separate scheduling entities.
//
// Evidence-first (ADR-0006 v2): every edit/archive writes an `experimental:*`
// event carrying before/after values, so changes are traceable and reversible.

import { createId } from '@paralleldrive/cuid2';
import { and, eq, isNull, ne, or, sql } from 'drizzle-orm';

import type { Db } from '@/db/client';
import { artifact, event, material_fsrs_state, question } from '@/db/schema';
import { writeEvent } from '@/server/events/queries';
import { assertKnowledgeIdsExist } from '@/capabilities/knowledge/server/validate';

export const QUESTION_PART_KIND = 'question_part' as const;

// Fields a question carries that describe variant / composite BLOODLINE. These
// are structurally owned by the variant-gen / parts owners and MUST NOT be
// editable through the question-bank PATCH surface (YUK-281 scope: 血缘字段拒改).
// Surfaced here so the route can reject them with a precise error.
export const BLOODLINE_FIELDS = [
  'variant_depth',
  'root_question_id',
  'parent_variant_id',
  'parent_question_id',
  'part_index',
] as const;

export interface QuestionAssociationCounts {
  attempts: number;
  fsrs_cards: number;
  paper_refs: number;
  mistakes: number;
}

/**
 * Count everything that references a question, for the DELETE warning surface.
 *
 *  - attempts:   event(action='attempt', subject_kind='question', subject_id=id)
 *  - mistakes:   the failure subset of attempts (ADR-0006 v2 — the `mistake`
 *                table was DROPped; failures ARE attempt events with
 *                outcome='failure'). See src/db/schema.ts:201.
 *  - fsrs_cards: material_fsrs_state(subject_kind='question', subject_id=id) —
 *                the legacy per-question FSRS card for unlabeled questions.
 *  - paper_refs: artifact rows whose tool_state.question_ids contains the id
 *                (same container query the detail backlink uses). Counts ALL
 *                references incl. drafts/archived — the warning is about data the
 *                user would orphan, so we do not filter archived here.
 */
export async function countQuestionAssociations(
  db: Db,
  questionId: string,
): Promise<QuestionAssociationCounts> {
  // The four counts are independent reads — run them concurrently.
  const [[attemptRow], [mistakeRow], [fsrsRow], [paperRow]] = await Promise.all([
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(event)
      .where(
        and(
          eq(event.action, 'attempt'),
          eq(event.subject_kind, 'question'),
          eq(event.subject_id, questionId),
        ),
      ),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(event)
      .where(
        and(
          eq(event.action, 'attempt'),
          eq(event.subject_kind, 'question'),
          eq(event.subject_id, questionId),
          eq(event.outcome, 'failure'),
        ),
      ),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(material_fsrs_state)
      .where(
        and(
          eq(material_fsrs_state.subject_kind, 'question'),
          eq(material_fsrs_state.subject_id, questionId),
        ),
      ),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(artifact)
      .where(sql`${artifact.tool_state}->'question_ids' @> ${JSON.stringify([questionId])}::jsonb`),
  ]);

  return {
    attempts: attemptRow?.n ?? 0,
    mistakes: mistakeRow?.n ?? 0,
    fsrs_cards: fsrsRow?.n ?? 0,
    paper_refs: paperRow?.n ?? 0,
  };
}

export function hasAnyAssociation(counts: QuestionAssociationCounts): boolean {
  return (
    counts.attempts > 0 || counts.mistakes > 0 || counts.fsrs_cards > 0 || counts.paper_refs > 0
  );
}

// ── Editable surface (YUK-281) ───────────────────────────────────────────────
// prompt_md / reference_md / choices_md / difficulty / knowledge_ids / kind /
// draft_status. Validation is done by the route (zod over core schema); this
// applies an already-validated patch.
export interface QuestionEditPatch {
  prompt_md?: string;
  reference_md?: string | null;
  choices_md?: string[] | null;
  difficulty?: number;
  knowledge_ids?: string[];
  kind?: string;
  draft_status?: 'draft' | 'active' | null;
}

export interface QuestionEditResult {
  // `noop` = patch contained no real change vs the current row (no version bump,
  // no audit event); `knowledge_invalid` = a knowledge_id was missing/archived
  // (re-validated inside the tx to close the TOCTOU window).
  status: 'updated' | 'noop' | 'conflict' | 'not_found' | 'knowledge_invalid';
  event_id?: string;
  version?: number;
  missing_knowledge_ids?: string[];
}

// Deep-equality for the edit diff — primitives via Object.is, arrays element-wise
// (knowledge_ids / choices_md). Keeps unchanged fields out of before/after so a
// full-form save doesn't fabricate audit entries or bump the version.
function patchValueEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  }
  return false;
}

/**
 * Apply an edit patch with optimistic locking + an `experimental:question_edit`
 * audit event (before/after of every changed field) in one transaction.
 */
export async function editQuestion(
  db: Db,
  questionId: string,
  expectedVersion: number,
  patch: QuestionEditPatch,
  actorRef: string,
): Promise<QuestionEditResult> {
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(question).where(eq(question.id, questionId)).limit(1);
    const row = rows[0];
    if (!row) return { status: 'not_found' };

    // Re-validate knowledge_ids inside the SAME transaction the update commits in.
    // The route does a pre-check for a friendly early 400, but doing it here too
    // closes the TOCTOU window where a knowledge node is archived between the
    // pre-check and the write. An empty array is a deliberate "clear all" and is
    // a no-op for validation.
    if (patch.knowledge_ids && patch.knowledge_ids.length > 0) {
      // `tx as Db`: the helper only reads, and a tx satisfies the query surface
      // (same cast as src/server/knowledge/rubric-validator.ts:443).
      const check = await assertKnowledgeIdsExist(tx as unknown as Db, patch.knowledge_ids);
      if (!check.ok) return { status: 'knowledge_invalid', missing_knowledge_ids: check.missing };
    }

    // Build the SET map + the before/after diff for the event payload. Only
    // include fields the caller actually CHANGED — `track` skips both undefined
    // (not submitted) and unchanged values so a full-form save doesn't fabricate
    // audit entries or bump the version on a no-op (which would also inflate
    // optimistic-lock 409s for honest concurrent edits).
    const now = new Date();
    const setValues: Partial<typeof question.$inferInsert> = {};
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};

    const track = <K extends keyof QuestionEditPatch>(
      key: K,
      column: keyof typeof question.$inferInsert,
      prev: unknown,
    ) => {
      if (patch[key] === undefined) return;
      const next = patch[key];
      if (patchValueEqual(prev, next)) return;
      // biome-ignore lint/suspicious/noExplicitAny: dynamic column assignment over a validated patch.
      (setValues as any)[column] = next;
      before[column as string] = prev;
      after[column as string] = next;
    };

    track('prompt_md', 'prompt_md', row.prompt_md);
    track('reference_md', 'reference_md', row.reference_md);
    track('choices_md', 'choices_md', row.choices_md);
    track('difficulty', 'difficulty', row.difficulty);
    track('knowledge_ids', 'knowledge_ids', row.knowledge_ids);
    track('kind', 'kind', row.kind);
    track('draft_status', 'draft_status', row.draft_status);

    // No real change: return the current version untouched, no event, no bump.
    // We still honour the optimistic-lock contract — a stale version on a no-op
    // is reported as a conflict so the caller refreshes.
    if (Object.keys(after).length === 0) {
      if (row.version !== expectedVersion) return { status: 'conflict' };
      return { status: 'noop', version: row.version };
    }

    const updated = await tx
      .update(question)
      .set({ ...setValues, updated_at: now, version: row.version + 1 })
      .where(and(eq(question.id, questionId), eq(question.version, expectedVersion)))
      .returning({ version: question.version });
    if (updated.length === 0) return { status: 'conflict' };

    const eventId = createId();
    await writeEvent(tx, {
      id: eventId,
      session_id: null,
      actor_kind: 'user',
      actor_ref: actorRef,
      action: 'experimental:question_edit',
      subject_kind: 'question',
      subject_id: questionId,
      outcome: 'success',
      payload: {
        question_id: questionId,
        previous_version: row.version,
        next_version: row.version + 1,
        before,
        after,
      },
      created_at: now,
    });

    return { status: 'updated', event_id: eventId, version: row.version + 1 };
  });
}

export interface QuestionArchiveResult {
  status: 'archived' | 'conflict' | 'not_found';
  event_id?: string;
  // Part question ids cascade-archived alongside the parent.
  cascaded_part_ids?: string[];
}

/**
 * Soft-archive a question by re-drafting it (draft_status='draft' — see file
 * header). Cascades to composite parts in the same transaction. Records intent
 * + previous state in `experimental:question_archive` and on metadata.
 */
export async function archiveQuestion(
  db: Db,
  questionId: string,
  expectedVersion: number,
  actorRef: string,
  reason = 'user',
): Promise<QuestionArchiveResult> {
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(question).where(eq(question.id, questionId)).limit(1);
    const row = rows[0];
    if (!row) return { status: 'not_found' };

    const now = new Date();
    const archivedAtSec = Math.floor(now.getTime() / 1000);

    const parentUpdate = await tx
      .update(question)
      .set({
        draft_status: 'draft',
        metadata: {
          ...(row.metadata ?? {}),
          archived_at: archivedAtSec,
          archived_reason: reason,
          archived_previous_draft_status: row.draft_status ?? null,
        },
        updated_at: now,
        version: row.version + 1,
      })
      .where(and(eq(question.id, questionId), eq(question.version, expectedVersion)))
      .returning({ id: question.id });
    if (parentUpdate.length === 0) return { status: 'conflict' };

    // Cascade: re-draft live composite parts so they don't outlive the parent in
    // the pool. Only parts NOT already drafted are touched (idempotent-ish).
    const cascaded = await tx
      .update(question)
      .set({
        draft_status: 'draft',
        metadata: sql`COALESCE(${question.metadata}, '{}'::jsonb) || ${JSON.stringify({
          archived_at: archivedAtSec,
          archived_reason: `cascade:${reason}`,
          archived_via_parent: questionId,
        })}::jsonb`,
        updated_at: now,
        version: sql`${question.version} + 1`,
      })
      .where(
        and(
          eq(question.kind, QUESTION_PART_KIND),
          eq(question.parent_question_id, questionId),
          or(isNull(question.draft_status), ne(question.draft_status, 'draft')),
        ),
      )
      .returning({ id: question.id });
    const cascadedPartIds = cascaded.map((r) => r.id);

    const eventId = createId();
    await writeEvent(tx, {
      id: eventId,
      session_id: null,
      actor_kind: 'user',
      actor_ref: actorRef,
      action: 'experimental:question_archive',
      subject_kind: 'question',
      subject_id: questionId,
      outcome: 'success',
      payload: {
        question_id: questionId,
        archived: true,
        reason,
        previous_draft_status: row.draft_status ?? null,
        previous_version: row.version,
        next_version: row.version + 1,
        cascaded_part_ids: cascadedPartIds,
      },
      created_at: now,
    });

    return { status: 'archived', event_id: eventId, cascaded_part_ids: cascadedPartIds };
  });
}
