// Ingest → practice bridge.
//
// Import writes questions but no tool_quiz artifact, so /practice cannot see the
// paper. This module builds that artifact on an explicit make-paper request; it is
// never auto-built at import, so the owner chooses which papers become takeable.

import { createId } from '@paralleldrive/cuid2';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import { ToolState, type ToolStateT } from '@/core/schema/business';
import type { Db, Tx } from '@/db/client';
import { artifact, question, question_block, source_document } from '@/db/schema';
import { artifactRowToCreateSnapshot, emitArtifactCreateEvent } from '@/kernel/artifacts';
import { ApiError } from '@/kernel/http';

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
 * Builds tool_state for an imported paper: one section, one assignment per question,
 * FSRS keyed on knowledge_ids[0], immediate feedback. Throws on an empty paper or a
 * question without knowledge ids, and validates through the ToolState schema.
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
      // Ingested questions are atomic, so the whole question is one slot.
      primary_knowledge_id: q.knowledge_ids[0],
      secondary_knowledge_ids: q.knowledge_ids.slice(1),
      selection_reason: 'ingested_paper',
      review_profile_snapshot: {},
    };
  });

  // tool_state is opaque jsonb to audit:schema, so this parse is the guard.
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
  /** Explicit subset to package; absent means all of the session's questions. */
  questionIds?: string[];
}

export interface CreateIngestionPaperResult {
  artifactId: string;
  /** true when an existing paper for this session was returned (idempotent). */
  reused: boolean;
}

/**
 * Creates or returns the session's imported-paper artifact. The session lock plus
 * the intent_source/source_ref lookup make a double-click idempotent. One session
 * maps to one paper, so an explicit subset that differs from the stored set is a
 * 409 rather than a silent stale reuse; the full-set path never conflicts.
 */
export async function createIngestionPaper(
  db: Db,
  params: CreateIngestionPaperParams,
): Promise<CreateIngestionPaperResult> {
  const now = new Date();
  // Omitted means the full set; an explicit empty array is a selection error, not
  // select-all. This service is the boundary, with the route schema as a mirror.
  if (params.questionIds !== undefined && params.questionIds.length === 0) {
    throw new ApiError(
      'validation_error',
      'question_ids must be a non-empty array when provided; omit it to package the full imported set',
      400,
    );
  }
  // Duplicate ids collapse onto one slot key, scrambling client state and making
  // total_slots disagree with the assignment list. Reject; callers must dedupe.
  if (params.questionIds !== undefined) {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const id of params.questionIds) {
      if (seen.has(id)) duplicates.add(id);
      seen.add(id);
    }
    if (duplicates.size > 0) {
      throw new ApiError(
        'validation_error',
        `question_ids must not contain duplicates; repeated ids: ${JSON.stringify([...duplicates])}`,
        400,
      );
    }
  }
  return db.transaction(async (tx: Tx) => {
    // Serialize concurrent make-paper calls; the xact lock releases at commit.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ingestion_paper:${params.sessionId}`}, 0))`,
    );

    // Normalize the requested set (session filter, requested order) before the
    // existing-paper check so a replay that names an external id stays idempotent.
    //
    // Paper order follows the source block order. inArray returns rows unordered,
    // and question.created_at is identical across an import batch, so the stable key
    // is question_block.ordinal (the same order /blocks displays), with block id and
    // question id as tiebreakers.
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
      // Re-order to the requested sequence; skip ids the session filter removed.
      const byId = new Map(rows.map((r) => [r.id, r]));
      questions = params.questionIds
        .map((id) => byId.get(id))
        .filter((r): r is { id: string; knowledge_ids: string[] } => r !== undefined);
    } else {
      // LEFT JOIN keeps manual/legacy questions; null ordinals sort last.
      questions = await tx
        .select({ id: question.id, knowledge_ids: question.knowledge_ids })
        .from(question)
        .leftJoin(
          question_block,
          sql`${question.metadata}->>'question_block_id' = ${question_block.id}`,
        )
        .where(sql`${question.metadata}->>'ingestion_session_id' = ${params.sessionId}`)
        .orderBy(asc(question_block.ordinal), asc(question_block.id), asc(question.id));
    }
    // Normalized sequence used by both the reuse comparison and the build.
    const normalizedQuestionIds = questions.map((q) => q.id);

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
      // Compare ordered normalized sequences: order is meaningful, so a reorder
      // is a different request. A full-set call has no set to conflict with.
      if (params.questionIds && params.questionIds.length > 0) {
        const existingIds = (existing.tool_state as ToolStateT | null)?.question_ids ?? [];
        const requested = normalizedQuestionIds;
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

    if (questions.length === 0) {
      throw new Error(
        `createIngestionPaper: no imported questions found for session ${params.sessionId}`,
      );
    }

    // Fall back to a generic title when the source has none.
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

    // Emit the create event from the materialized row (DB defaults applied) so the
    // fold reproduces it and the strict snapshot never false-rejects.
    const [insertedArtifact] = await tx
      .insert(artifact)
      .values({
        id: artifactId,
        type: 'tool_quiz',
        title,
        parent_artifact_id: null,
        knowledge_ids: knowledgeIds,
        intent_source: INGESTION_PAPER_INTENT_SOURCE,
        source: 'imported',
        // Idempotency key and traceability back to the session.
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
      })
      .returning();
    await emitArtifactCreateEvent(tx, {
      row: artifactRowToCreateSnapshot(insertedArtifact),
      actorKind: 'user',
      actorRef: 'self',
      createdAt: now,
    });

    return { artifactId, reused: false };
  });
}
