// POST /api/ingestion/[id]/blocks/[block_id]/enroll
//
// One-block user entry into the item bank: write the missing prompt (version CAS through
// the structured-edit owner) and/or retry an enrollment that previously failed. It uses
// the same question/enroll owners as the automatic path, so there is exactly one question
// per block and admission is still enqueued by the publication event.

import { and, eq, isNull, sql } from 'drizzle-orm';

import type { Db, Tx } from '@/db/client';
import { knowledge, learning_session, question, question_block } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { readQuestionServing } from '@/kernel/read-models/question-serving';
import { resolveSessionDerivationPolicy } from '@/kernel/read-models/usage-policy';
import { setMissingPrompt, updatePrompt } from './block-structured-edit';
import { detectStudentWork } from './capture/block-answer-evidence';
import { blockHasPrompt } from './capture/question-text';
import { enrollBlockIntoItemBank } from './item-bank-enrollment';
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
      undefined,
      { current_version: block.version },
    );
  }

  let current = block;
  if (params.promptMd !== undefined) {
    const edited = current.structured
      ? await updatePrompt(db, {
          blockId: params.blockId,
          nodeId: current.structured.id,
          promptText: params.promptMd,
          expectedVersion: params.expectedVersion,
          actorRef: 'ingestion:block_enroll',
          actorKind: 'user',
        })
      : await setMissingPrompt(db, {
          blockId: params.blockId,
          promptText: params.promptMd,
          expectedVersion: params.expectedVersion,
          actorRef: 'ingestion:block_enroll',
          actorKind: 'user',
        });
    if (
      edited.status === 'skipped:version_conflict' ||
      edited.status === 'skipped:structured_exists'
    ) {
      const [fresh] = await db
        .select({ version: question_block.version })
        .from(question_block)
        .where(eq(question_block.id, params.blockId));
      throw new ApiError(
        'version_conflict',
        `question_block ${params.blockId} changed while editing its prompt`,
        409,
        undefined,
        { current_version: fresh?.version ?? current.version },
      );
    }
    if (edited.status !== 'written') {
      throw new ApiError(
        'prompt_edit_unavailable',
        `question_block ${params.blockId} prompt edit skipped: ${edited.status}`,
        409,
        undefined,
        { current_version: current.version },
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
      undefined,
      { current_version: current.version },
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
      undefined,
      { current_version: current.version },
    );
  }

  // Attribution is a derivation step over restricted content: answer_only/crisis
  // documents enroll without knowledge_ids (same 'missing' outcome as auto-enroll),
  // which also keeps the knowledge_ids>0 gates of the nightly model lanes unarmed.
  const knowledgeIds =
    (await resolveSessionDerivationPolicy(db, params.sessionId)) === 'allow'
      ? await resolveExactKnowledge(db, current.knowledge_hint)
      : [];
  const knowledgeState: 'attributed' | 'missing' =
    knowledgeIds.length > 0 ? 'attributed' : 'missing';
  const sourceDocumentId = session.source_document_id;
  if (!sourceDocumentId) {
    throw new ApiError('conflict', `session ${params.sessionId} has no source document`, 409);
  }
  const generatedBy = params.source === 'rescue' ? 'rescue' : 'user_retry';

  const result = await enrollBlockIntoItemBank({
    db,
    block: current,
    knowledgeIds,
    difficulty: 3,
    confidence: 0,
    markers: {
      enrolled_by: generatedBy,
      knowledge: knowledgeState,
      confidence: 0,
      figures_attached: current.figures.length,
      student_work: detectStudentWork(current),
    },
    sourceDocumentId,
    now: new Date(),
    generatedBy,
  });
  if (!result) {
    const [after] = await db
      .select()
      .from(question_block)
      .where(eq(question_block.id, params.blockId));
    if (after && after.status !== 'draft') {
      return readCurrent(db, after, 'already_enrolled', knowledgeState);
    }
    throw new ApiError(
      'version_conflict',
      `question_block ${params.blockId} changed during enrollment`,
      409,
      undefined,
      { current_version: after?.version ?? current.version },
    );
  }

  const serving = await readQuestionServing(db, [result.question_id]);
  return {
    block_id: result.block_id,
    status: 'enrolled',
    question_id: result.question_id,
    block_status: 'auto_enrolled',
    block_version: result.block_version,
    knowledge: knowledgeState,
    library_visible: true,
    admission_status: serving.byId.get(result.question_id)?.admission?.status ?? 'pending',
  };
}

function storedKnowledgeState(metadata: unknown): 'attributed' | 'missing' | null {
  const markers = (metadata as { ingestion_enrollment?: { knowledge?: unknown } } | null)
    ?.ingestion_enrollment;
  return markers?.knowledge === 'attributed' || markers?.knowledge === 'missing'
    ? markers.knowledge
    : null;
}
