// YUK-214 (Strategy D · S1) — ingest→practice bridge.
//
// import (existing) writes N×question + N×event + N×learning_record but NEVER a
// tool_quiz artifact, so an imported paper's questions exist yet /practice can't
// see them as "a takeable paper" (the structural break, plan §1.1). This module
// is the ONE new write path: read a session's imported questions → build a
// tool_quiz artifact (each question = one section assignment) → INSERT it. The
// consumer side (readPaperSections / resolveSlotAssignment / getPracticeList /
// submitPaperSlot) is UNCHANGED — it already supports tool_state.sections[].
//
// Form (b) — OWNER-FORK §13: a paper is built only on an explicit make-paper
// request (POST /api/ingestion/[id]/make-paper), never auto-built at import
// commit, so the owner decides which imported papers become takeable.

import { createId } from '@paralleldrive/cuid2';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import { ToolState, type ToolStateT } from '@/core/schema/business';
import type { Db, Tx } from '@/db/client';
import { artifact, question, question_block, source_document } from '@/db/schema';
import { ApiError } from '@/server/http/errors';

/** Minimal question shape the builder needs (subset of the question row). */
export interface IngestionPaperQuestion {
  id: string;
  knowledge_ids: string[];
}

export interface BuildIngestionPaperParams {
  sessionId: string;
  sourceDocumentId: string;
}

export const INGESTION_PAPER_INTENT_SOURCE = 'ingestion_paper' as const;

/**
 * Build the tool_quiz `tool_state` for an imported paper (§3.2). Pure: question
 * rows in input order → one section, one assignment per question, FSRS keyed on
 * each question's primary knowledge (knowledge_ids[0]). feedback_policy is
 * 'immediate' so an imported paper's judgements are immediately visible.
 *
 * Throws on an empty question set (no empty papers) or a question with no
 * knowledge_ids (primary_knowledge_id would be undefined — the invariant
 * import/route enforces via knowledge_ids.min(1), re-asserted here so the builder
 * is safe standalone). Passes the ToolState Zod barrier before returning (RL4).
 */
export function buildIngestionPaperToolState(
  questions: IngestionPaperQuestion[],
  params: BuildIngestionPaperParams,
): ToolStateT {
  if (questions.length === 0) {
    throw new Error('buildIngestionPaperToolState: a paper needs at least one question');
  }

  const knowledgeFocus = new Set<string>();
  const assignments = questions.map((q) => {
    if (q.knowledge_ids.length === 0) {
      throw new Error(
        `buildIngestionPaperToolState: question ${q.id} has no knowledge_id (primary would be undefined)`,
      );
    }
    for (const k of q.knowledge_ids) knowledgeFocus.add(k);
    return {
      question_id: q.id,
      // part_ref omitted: ingested questions are atomic (no StructuredQuestion
      // sub-node slot), so the whole question is one slot.
      primary_knowledge_id: q.knowledge_ids[0],
      secondary_knowledge_ids: q.knowledge_ids.slice(1),
      selection_reason: 'ingested_paper',
      review_profile_snapshot: {},
    };
  });

  // Zod barrier (RL4): tool_state is jsonb, opaque to audit:schema; the parse is
  // the load-bearing guard (same discipline as write_review_plan).
  return ToolState.parse({
    question_ids: questions.map((q) => q.id),
    sections: [
      {
        knowledge_focus: [...knowledgeFocus],
        feedback_policy: 'immediate',
        adaptation_policy: 'none',
        assignments,
      },
    ],
    session_meta: {
      ingestion_session_id: params.sessionId,
      source_document_id: params.sourceDocumentId,
      // Not an agent product — no tool-context run.
      tool_context_task_run_id: null,
    },
  });
}

export interface CreateIngestionPaperParams {
  sessionId: string;
  /**
   * Explicit override of the questions to package (import returns these). When
   * absent the writer reverse-queries question.metadata->>'ingestion_session_id'
   * (§3.3) — more robust (independent of client state, replayable).
   */
  questionIds?: string[];
}

export interface CreateIngestionPaperResult {
  artifactId: string;
  /** true when an existing paper for this session was returned (idempotent). */
  reused: boolean;
}

/**
 * Create (or return the existing) imported-paper artifact for a session.
 *
 * Idempotent on sessionId: an advisory lock keyed on the session + a lookup for
 * an existing `intent_source='ingestion_paper' AND source_ref=session` artifact
 * means a double-click returns the same paper instead of duplicating it (mirrors
 * write_review_plan's per-run lock). The key is sessionId-only because the plan
 * keeps a fixed "one session, one paper" range (Cross-统合 F-7), so there is no
 * same-session multi-paper fork.
 *
 * F1 (PR #309 round-2, YUK-214) — that fixed range is the reason an explicit
 * `questionIds` subset must NOT silently reuse a paper built from a different
 * set. Pre-fix, a first call with `['q1']` then a second call with `['q2']`
 * returned the SAME (stale, q1-only) artifact, dropping the caller's new subset
 * on the floor. The chosen reconciliation (Cross-统合 F-7: one session = one
 * paper, do not re-package) is to reject with 409 when the existing paper's
 * question set differs from an EXPLICITLY-passed `questionIds` — the owner must
 * delete/rebuild rather than have one session silently fork into two ranges.
 * The default full-set path (no `questionIds`) stays purely idempotent: it never
 * specifies a set, so it can never conflict with the existing paper.
 */
export async function createIngestionPaper(
  db: Db,
  params: CreateIngestionPaperParams,
): Promise<CreateIngestionPaperResult> {
  const now = new Date();
  return db.transaction(async (tx: Tx) => {
    // Serialise concurrent make-paper calls for the same session; auto-released
    // at txn boundary (no UNIQUE index → no migration, same as write_review_plan).
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ingestion_paper:${params.sessionId}`}, 0))`,
    );

    const [existing] = await tx
      .select({ id: artifact.id, tool_state: artifact.tool_state })
      .from(artifact)
      .where(
        and(
          eq(artifact.intent_source, INGESTION_PAPER_INTENT_SOURCE),
          eq(artifact.source_ref, params.sessionId),
        ),
      )
      .limit(1);
    if (existing) {
      // F1 (PR #309 round-2) — an explicitly-passed questionIds set must match the
      // existing paper's set; otherwise reuse would silently drop the caller's new
      // subset. Compare as ORDERED sequences: the paper's slot order is meaningful
      // (F2/F3), so a reorder of the same ids is still a different paper request.
      // A bare idempotent call (no questionIds) carries no set to conflict with.
      if (params.questionIds && params.questionIds.length > 0) {
        const existingIds = (existing.tool_state as ToolStateT | null)?.question_ids ?? [];
        const requested = params.questionIds;
        const mismatch =
          existingIds.length !== requested.length ||
          existingIds.some((id, i) => id !== requested[i]);
        if (mismatch) {
          throw new ApiError(
            'conflict',
            `ingestion session ${params.sessionId} already has a paper (questions ${JSON.stringify(
              existingIds,
            )}); the requested question_ids ${JSON.stringify(
              requested,
            )} differ. One session maps to one paper — delete the existing paper to rebuild with a different set.`,
            409,
          );
        }
      }
      return { artifactId: existing.id, reused: true };
    }

    // Resolve the questions: explicit override, else reverse-query metadata.
    //
    // Paper question order must be deterministic AND reconstruct the user's
    // original paper sequence. `inArray` / a bare WHERE returns rows in an
    // UNSPECIFIED order (Postgres is free to return them in any sequence), which
    // silently scrambled the paper's slot order vs the user's original paper.
    //   - explicit override: re-sort the fetched rows into params.questionIds
    //     order (the caller's requested sequence is the source of truth).
    //   - fall-through reverse-query: ORDER BY the SOURCE paper's block order.
    //
    // F3 (PR #309 round-2, YUK-214) — original-paper order key. Round-1 ordered
    // by (question.created_at, question.id), but import writes the whole question
    // batch with one shared `now` (import/route.ts:250 `const now = new Date()`),
    // so question.created_at is constant within a session and `id` (cuid2) is
    // UNORDERED — the result was deterministic-but-arbitrary, not the paper order.
    //
    // The stable original-paper order lives on `question_block`: every imported
    // question persists `metadata.question_block_id` (import/route.ts:407,421),
    // and the block list's canonical display order is
    // `ORDER BY question_block.created_at` (the /blocks read path,
    // app/api/ingestion/[id]/blocks/route.ts:65 — the single source of truth for
    // "the user's paper order"). Unlike question rows, block `created_at` is set
    // at EXTRACTION time (one block per extracted item, in reading order), so it
    // is a genuine positional key. We join question → question_block on that id
    // and order by (question_block.created_at, question_block.id) — the same key
    // /blocks uses — so the paper's slot sequence equals the on-screen block
    // order. The `id` tiebreaker covers virtual/merged cards minted at import
    // time (which DO share `now`), keeping the order repeatable for those too.
    let questions: Array<{ id: string; knowledge_ids: string[] }>;
    if (params.questionIds && params.questionIds.length > 0) {
      const rows = await tx
        .select({ id: question.id, knowledge_ids: question.knowledge_ids })
        .from(question)
        .where(
          and(
            inArray(question.id, params.questionIds),
            sql`${question.metadata}->>'ingestion_session_id' = ${params.sessionId}`,
          ),
        );
      // Re-order into the caller's requested sequence; drop ids the WHERE filtered
      // out (not in this session) by skipping unresolved entries.
      const byId = new Map(rows.map((r) => [r.id, r]));
      questions = params.questionIds
        .map((id) => byId.get(id))
        .filter((r): r is { id: string; knowledge_ids: string[] } => r !== undefined);
    } else {
      // LEFT JOIN so a question whose metadata.question_block_id has no matching
      // block row (manual/legacy import path) still appears; such rows sort last
      // (NULL block created_at) with question.id as the final stable tiebreaker.
      questions = await tx
        .select({ id: question.id, knowledge_ids: question.knowledge_ids })
        .from(question)
        .leftJoin(
          question_block,
          sql`${question.metadata}->>'question_block_id' = ${question_block.id}`,
        )
        .where(sql`${question.metadata}->>'ingestion_session_id' = ${params.sessionId}`)
        .orderBy(asc(question_block.created_at), asc(question_block.id), asc(question.id));
    }

    if (questions.length === 0) {
      throw new Error(
        `createIngestionPaper: no imported questions found for session ${params.sessionId}`,
      );
    }

    // source_document.title (nullable) → paper title fallback.
    const [doc] = await tx
      .select({ id: source_document.id, title: source_document.title })
      .from(source_document)
      .where(
        sql`${source_document.id} = (SELECT source_document_id FROM learning_session WHERE id = ${params.sessionId})`,
      )
      .limit(1);
    const sourceDocumentId = doc?.id ?? '';
    const title = doc?.title ?? '导入试卷';

    const toolState = buildIngestionPaperToolState(questions, {
      sessionId: params.sessionId,
      sourceDocumentId,
    });

    const knowledgeIds = [...new Set(questions.flatMap((q) => q.knowledge_ids))];
    const artifactId = `ingestion_paper_${createId()}`;

    await tx.insert(artifact).values({
      id: artifactId,
      type: 'tool_quiz',
      title,
      parent_artifact_id: null,
      knowledge_ids: knowledgeIds,
      intent_source: INGESTION_PAPER_INTENT_SOURCE,
      // 'imported' (user's real paper), NOT 'ai_generated'.
      source: 'imported',
      // Back-reference to the ingestion session (idempotency key + traceability).
      source_ref: params.sessionId,
      body_blocks: null,
      attrs: {
        ingestion_session_id: params.sessionId,
        source_document_id: sourceDocumentId,
        entrypoint: 'ingestion_make_paper',
      } as never,
      tool_kind: INGESTION_PAPER_INTENT_SOURCE,
      tool_state: toolState as never,
      generation_status: 'ready',
      verification_status: 'not_required',
      history: [],
      created_at: now,
      updated_at: now,
      version: 0,
    });

    return { artifactId, reused: false };
  });
}
