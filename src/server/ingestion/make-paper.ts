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
import { and, eq, inArray, sql } from 'drizzle-orm';

import { ToolState, type ToolStateT } from '@/core/schema/business';
import type { Db, Tx } from '@/db/client';
import { artifact, question, source_document } from '@/db/schema';

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
 * Idempotent on sessionId alone: an advisory lock keyed on the session + a
 * lookup for an existing `intent_source='ingestion_paper' AND source_ref=session`
 * artifact means a double-click returns the same paper instead of duplicating it
 * (mirrors write_review_plan's per-run lock). The key is sessionId-only because
 * the package range is fixed ("all imported questions" — outcome_filter was cut,
 * Cross-统合 F-7/F-9), so there is no same-session multi-paper fork.
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
      .select({ id: artifact.id })
      .from(artifact)
      .where(
        and(
          eq(artifact.intent_source, INGESTION_PAPER_INTENT_SOURCE),
          eq(artifact.source_ref, params.sessionId),
        ),
      )
      .limit(1);
    if (existing) {
      return { artifactId: existing.id, reused: true };
    }

    // Resolve the questions: explicit override, else reverse-query metadata.
    const questions =
      params.questionIds && params.questionIds.length > 0
        ? await tx
            .select({ id: question.id, knowledge_ids: question.knowledge_ids })
            .from(question)
            .where(
              and(
                inArray(question.id, params.questionIds),
                sql`${question.metadata}->>'ingestion_session_id' = ${params.sessionId}`,
              ),
            )
        : await tx
            .select({ id: question.id, knowledge_ids: question.knowledge_ids })
            .from(question)
            .where(sql`${question.metadata}->>'ingestion_session_id' = ${params.sessionId}`);

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
