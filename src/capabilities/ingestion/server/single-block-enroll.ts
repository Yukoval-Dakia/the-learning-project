// POST /api/ingestion/[id]/blocks/[block_id]/enroll
//
// One-block user entry into the item bank: write the missing prompt (version CAS through
// the structured-edit owner) and/or retry an enrollment that previously failed. It uses
// the same question/enroll owners as the automatic path, so there is exactly one question
// per block and admission is still enqueued by the publication event.

import { createId } from '@paralleldrive/cuid2';
import { and, eq, isNull, sql } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { acquireLearningStateWriteLock } from '@/db/learning-state-lock';
import { knowledge, learning_session, question, question_block } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { readQuestionServing } from '@/kernel/read-models/question-serving';
import { updatePrompt } from './block-structured-edit';
import { recordCapturedQuestion, settleCapturedBlock } from './capture/captured-question';
import { blockHasPrompt } from './capture/question-text';
import { hasInflightAutoEnroll } from './session-blocks-read';

export interface EnrollIngestionBlockParams {
  sessionId: string;
  blockId: string;
  expectedVersion: number;
  promptMd?: string;
  /** Rescue is an explicit one-block user action; it may proceed while a batch job waits. */
  source?: 'user' | 'rescue';
}

export type EnrollIngestionBlockStatus = 'enrolled' | 'already_enrolled';

export interface EnrollIngestionBlockResult {
  block_id: string;
  status: EnrollIngestionBlockStatus;
  question_id: string;
  block_status: string;
  block_version: number;
  knowledge: 'attributed' | 'missing';
  library_visible: boolean;
  admission_status: 'pending' | 'admitted' | 'failed' | 'undecided';
}

/** Exact-name lookup only; the single-block retry never spends another tagging model call. */
async function resolveExactKnowledge(db: Db, hint: string | null): Promise<string[]> {
  const name = hint?.trim();
  if (!name) return [];
  const rows = await db
    .select({ id: knowledge.id })
    .from(knowledge)
    .where(and(isNull(knowledge.archived_at), sql`lower(${knowledge.name}) = lower(${name})`))
    .limit(2);
  return rows.length === 1 ? [rows[0].id] : [];
}

async function readCurrent(
  db: Db | Tx,
  block: typeof question_block.$inferSelect,
  status: EnrollIngestionBlockStatus,
  knowledgeState: 'attributed' | 'missing',
): Promise<EnrollIngestionBlockResult> {
  const questionId = block.imported_question_id;
  if (!questionId) {
    throw new ApiError(
      'conflict',
      `question_block ${block.id} is '${block.status}' without an enrolled question`,
      409,
    );
  }
  const [row] = await db
    .select({ draft_status: question.draft_status, metadata: question.metadata })
    .from(question)
    .where(eq(question.id, questionId));
  if (!row) {
    throw new ApiError(
      'conflict',
      `question_block ${block.id} links missing question ${questionId}`,
      409,
    );
  }
  const serving = await readQuestionServing(db, [questionId]);
  const admission = serving.byId.get(questionId)?.admission;
  return {
    block_id: block.id,
    status,
    question_id: questionId,
    block_status: block.status,
    block_version: block.version,
    knowledge: storedKnowledgeState(row.metadata) ?? knowledgeState,
    library_visible: row.draft_status !== 'draft',
    admission_status: admission?.status ?? 'undecided',
  };
}

export async function enrollIngestionBlock(
  db: Db,
  params: EnrollIngestionBlockParams,
): Promise<EnrollIngestionBlockResult> {
  const [session] = await db
    .select()
    .from(learning_session)
    .where(eq(learning_session.id, params.sessionId));
  if (session?.type !== 'ingestion') {
    throw new ApiError('not_found', `ingestion session ${params.sessionId} not found`, 404);
  }
  if (session.status !== 'extracted' && session.status !== 'partial') {
    throw new ApiError(
      'conflict',
      `session ${params.sessionId} is '${session.status}'; enrollment needs extracted or partial`,
      409,
    );
  }
  const [block] = await db
    .select()
    .from(question_block)
    .where(
      and(
        eq(question_block.id, params.blockId),
        eq(question_block.ingestion_session_id, params.sessionId),
      ),
    );
  if (!block) {
    throw new ApiError(
      'not_found',
      `question_block ${params.blockId} not found in session ${params.sessionId}`,
      404,
    );
  }
  if (block.status === 'ignored') {
    throw new ApiError('conflict', `question_block ${params.blockId} was ignored`, 409);
  }
  // Repeated click after the first success: report the existing row, never a second one.
  if (block.status !== 'draft') {
    return readCurrent(db, block, 'already_enrolled', 'missing');
  }
  if (block.version !== params.expectedVersion) {
    throw new ApiError(
      'version_conflict',
      `question_block ${params.blockId} is at version ${block.version}, expected ${params.expectedVersion}`,
      409,
    );
  }

  let current = block;
  if (params.promptMd !== undefined) {
    if (!current.structured) {
      throw new ApiError(
        'prompt_edit_unavailable',
        `question_block ${params.blockId} has no structured tree to edit`,
        409,
      );
    }
    const edited = await updatePrompt(db, {
      blockId: params.blockId,
      nodeId: current.structured.id,
      promptText: params.promptMd,
      expectedVersion: params.expectedVersion,
      actorRef: 'ingestion:block_enroll',
      actorKind: 'user',
    });
    if (edited.status === 'skipped:version_conflict') {
      throw new ApiError(
        'version_conflict',
        `question_block ${params.blockId} changed while editing its prompt`,
        409,
      );
    }
    if (edited.status !== 'written') {
      throw new ApiError(
        'prompt_edit_unavailable',
        `question_block ${params.blockId} prompt edit skipped: ${edited.status}`,
        409,
      );
    }
    const [reloaded] = await db
      .select()
      .from(question_block)
      .where(eq(question_block.id, params.blockId));
    if (!reloaded) {
      throw new ApiError('not_found', `question_block ${params.blockId} not found`, 404);
    }
    current = reloaded;
  }

  if (!blockHasPrompt(current)) {
    throw new ApiError(
      'prompt_missing',
      `question_block ${params.blockId} has no printed prompt; send prompt_md first`,
      409,
    );
  }
  // The automatic worker may still be tagging this page. Let it finish rather than
  // running a second attribution/tag pass; its outcome leaves the block enrolled or
  // draft, and a retry after it settles is the supported path.
  if (params.source !== 'rescue' && (await hasInflightAutoEnroll(db, params.sessionId))) {
    throw new ApiError(
      'enroll_in_progress',
      `session ${params.sessionId} still has an auto_enroll delivery in flight`,
      409,
    );
  }

  const knowledgeIds = await resolveExactKnowledge(db, current.knowledge_hint);
  const knowledgeState: 'attributed' | 'missing' =
    knowledgeIds.length > 0 ? 'attributed' : 'missing';
  const now = new Date();
  const questionId = createId();
  const sourceDocumentId = session.source_document_id;
  if (!sourceDocumentId) {
    throw new ApiError('conflict', `session ${params.sessionId} has no source document`, 409);
  }

  try {
    return await db.transaction(async (tx) => {
      await acquireLearningStateWriteLock(tx);
      const [locked] = await tx
        .select()
        .from(question_block)
        .where(eq(question_block.id, params.blockId))
        .for('update');
      if (!locked) {
        throw new ApiError('not_found', `question_block ${params.blockId} not found`, 404);
      }
      if (locked.status !== 'draft') {
        // Lost a race with the worker or a concurrent click; report that row.
        return readCurrent(tx, locked, 'already_enrolled', 'missing');
      }
      if (locked.version !== current.version) {
        throw new ApiError(
          'version_conflict',
          `question_block ${params.blockId} changed during enrollment`,
          409,
        );
      }
      const [lockedSession] = await tx
        .select({ status: learning_session.status })
        .from(learning_session)
        .where(eq(learning_session.id, params.sessionId));
      if (lockedSession?.status !== 'extracted' && lockedSession?.status !== 'partial') {
        throw new ApiError(
          'conflict',
          `session ${params.sessionId} left the rescuable state during enrollment`,
          409,
        );
      }

      await recordCapturedQuestion(tx, {
        questionId,
        sessionId: params.sessionId,
        blockId: locked.id,
        sourceDocumentId,
        source: session.entrypoint ?? 'vision_paper',
        content: { from: 'block', block: locked },
        knowledgeIds,
        difficulty: 3,
        draftStatus: 'active',
        extraMetadata: {
          ingestion_enrollment: {
            mode: 'single_block',
            knowledge: knowledgeState,
            enrolled_by: 'user_retry',
          },
        },
        actorRef: 'ingestion:block_enroll',
        now,
      });
      await settleCapturedBlock(tx, {
        transition: 'auto_enroll',
        blockId: locked.id,
        guard: { kind: 'version_cas', version: locked.version },
        enroll: {
          questionId,
          outcome: 'unanswered',
          answerMd: '',
          answerImageRefs: [],
          knowledgeIds,
          imageRefs: locked.image_refs,
          captureMode: locked.image_refs.length > 0 ? 'image' : 'text',
          sourceDocumentId,
          now,
          generatedBy: 'workflow_judge',
        },
      });
      const serving = await readQuestionServing(tx, [questionId]);
      return {
        block_id: locked.id,
        status: 'enrolled' as const,
        question_id: questionId,
        block_status: 'auto_enrolled',
        block_version: locked.version + 1,
        knowledge: knowledgeState,
        library_visible: true,
        admission_status: serving.byId.get(questionId)?.admission?.status ?? 'pending',
      };
    });
  } catch (error) {
    // A concurrent writer may have committed between our read and the lock.
    if (error instanceof ApiError && error.status === 409) throw error;
    const [after] = await db
      .select()
      .from(question_block)
      .where(eq(question_block.id, params.blockId));
    if (after && after.status !== 'draft') {
      return readCurrent(db, after, 'already_enrolled', 'missing');
    }
    throw error;
  }
}

function storedKnowledgeState(metadata: unknown): 'attributed' | 'missing' | null {
  const markers = (metadata as { ingestion_enrollment?: { knowledge?: unknown } } | null)
    ?.ingestion_enrollment;
  return markers?.knowledge === 'attributed' || markers?.knowledge === 'missing'
    ? markers.knowledge
    : null;
}
