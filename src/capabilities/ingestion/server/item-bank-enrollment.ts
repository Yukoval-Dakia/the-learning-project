// One owner for "how one captured block enters the item bank". The automatic worker and
// the manual single-block endpoint both call this; the branch on student evidence, the
// capture of private answer evidence, and the enrollment settle live only here.

import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';

import type { StructuredQuestionT } from '@/core/schema/structured_question';
import type { Db } from '@/db/client';
import { acquireLearningStateWriteLock } from '@/db/learning-state-lock';
import { learning_session, question, question_block } from '@/db/schema';
import type { DocumentUsage } from '@/kernel/read-models/usage-policy';
import { captureIngestionOriginal } from './assessment-capture';
import { detectStudentWork, pageScopedQuestionImageRefs } from './capture/block-answer-evidence';
import {
  capturedQuestionShape,
  recordCapturedQuestion,
  settleCapturedBlock,
} from './capture/captured-question';

export type EnrollmentGeneratedBy = 'workflow_judge' | 'user_retry' | 'rescue';

export interface EnrollmentMarkers {
  enrolled_by: EnrollmentGeneratedBy;
  /** 'missing' = attribution ran and produced nothing (or failed); 'restricted' =
   *  attribution was suppressed by the document's derivation policy — a distinct,
   *  learner-visible fact, not a repairable gap. */
  knowledge: 'attributed' | 'missing' | 'restricted';
  confidence: number;
  figures_attached: number;
  student_work: boolean;
}

export interface EnrollBlockIntoBankParams {
  db: Db;
  block: typeof question_block.$inferSelect;
  knowledgeIds: string[];
  difficulty: number;
  confidence: number;
  markers: EnrollmentMarkers;
  sourceDocumentId: string;
  now: Date;
  generatedBy: EnrollmentGeneratedBy;
  docUsage?: DocumentUsage;
  /** Defaults to the pages this question spans. */
  pageRefs?: string[];
  kind?: string;
  draftStatus?: 'active' | 'draft';
  extraMetadata?: Record<string, unknown>;
}

export interface EnrolledBlock {
  block_id: string;
  question_id: string;
  attempt_event_id: string | null;
  record_id: string;
  knowledge_ids: string[];
  confidence: number;
  block_version: number;
  captured_answer: boolean;
}

/**
 * Returns null when the block was edited or superseded between the caller's read and the
 * row lock; the caller reports that as a conflict/needs-retry, never as an enrollment.
 */
export async function enrollBlockIntoItemBank(
  params: EnrollBlockIntoBankParams,
): Promise<EnrolledBlock | null> {
  const { block } = params;
  const pageRefs = params.pageRefs ?? pageScopedQuestionImageRefs(block);
  const hasCapturedAnswer = Boolean(block.wrong_answer_md?.trim()) || detectStudentWork(block);
  const provenance =
    params.generatedBy === 'workflow_judge' ? 'workflow_judge' : 'ingestion_capture';

  if (hasCapturedAnswer) {
    const captured = await captureIngestionOriginal(params.db, {
      block,
      knowledgeIds: params.knowledgeIds,
      difficulty: params.difficulty,
      confidence: params.confidence,
      canEnroll: true,
      pageRefs,
      now: params.now,
      docUsage: params.docUsage,
      enrollmentMetadata: { ...params.markers },
      generatedBy: provenance,
    });
    if (!captured) return null;
    for (const warning of captured.warnings) {
      console.warn(`[enroll:capture] ${warning}`);
    }
    return params.db.transaction(async (tx) => {
      await acquireLearningStateWriteLock(tx);
      const [current] = await tx
        .select({ status: question_block.status, version: question_block.version })
        .from(question_block)
        .where(eq(question_block.id, block.id))
        .for('update');
      const [session] = await tx
        .select({ status: learning_session.status, entrypoint: learning_session.entrypoint })
        .from(learning_session)
        .where(eq(learning_session.id, block.ingestion_session_id));
      if (
        current?.status !== 'draft' ||
        current.version !== block.version ||
        (session?.status !== 'extracted' && session?.status !== 'partial')
      ) {
        // Capture question and attempt stay as private evidence; no enrollment link.
        return null;
      }
      const enroll = await settleCapturedBlock(tx, {
        transition: 'auto_enroll',
        blockId: block.id,
        guard: { kind: 'version_cas', version: block.version },
        enroll: {
          questionId: captured.questionId,
          outcome: 'unanswered',
          capturedAttemptEventId: captured.attemptEventId,
          answerMd: '',
          answerImageRefs: [],
          knowledgeIds: captured.knowledgeIds,
          imageRefs: block.image_refs,
          captureMode: block.image_refs.length > 0 ? 'image' : 'text',
          sourceDocumentId: captured.sourceDocumentId,
          docUsage: params.docUsage,
          now: params.now,
          generatedBy: provenance,
        },
      });
      await tx
        .update(question)
        .set({ draft_status: params.draftStatus ?? 'active', updated_at: params.now })
        .where(eq(question.id, captured.questionId));
      return {
        block_id: block.id,
        question_id: captured.questionId,
        attempt_event_id: enroll.attemptEventId,
        record_id: enroll.recordId,
        knowledge_ids: captured.knowledgeIds,
        confidence: params.confidence,
        block_version: block.version + 1,
        captured_answer: true,
      };
    });
  }

  return params.db.transaction(async (tx) => {
    await acquireLearningStateWriteLock(tx);
    const [current] = await tx
      .select({ status: question_block.status, version: question_block.version })
      .from(question_block)
      .where(eq(question_block.id, block.id))
      .for('update');
    const [session] = await tx
      .select({ status: learning_session.status, entrypoint: learning_session.entrypoint })
      .from(learning_session)
      .where(eq(learning_session.id, block.ingestion_session_id));
    if (
      current?.status !== 'draft' ||
      current.version !== block.version ||
      (session?.status !== 'extracted' && session?.status !== 'partial')
    ) {
      return null;
    }
    const kind =
      params.kind ?? capturedQuestionShape(block.structured as StructuredQuestionT | null).kind;
    const questionId = createId();
    await recordCapturedQuestion(tx, {
      questionId,
      sessionId: block.ingestion_session_id,
      blockId: block.id,
      sourceDocumentId: params.sourceDocumentId,
      source: session.entrypoint ?? 'vision_paper',
      content: { from: 'block', block },
      kind: kind as Parameters<typeof recordCapturedQuestion>[1]['kind'],
      knowledgeIds: params.knowledgeIds,
      difficulty: params.difficulty,
      draftStatus: params.draftStatus ?? 'active',
      extraMetadata: {
        ...params.extraMetadata,
        ingestion_enrollment: params.markers,
      },
      actorRef: `enroll:${params.generatedBy}`,
      now: params.now,
    });
    const enroll = await settleCapturedBlock(tx, {
      transition: 'auto_enroll',
      blockId: block.id,
      guard: { kind: 'version_cas', version: block.version },
      enroll: {
        questionId,
        outcome: 'unanswered',
        answerMd: '',
        answerImageRefs: [],
        knowledgeIds: params.knowledgeIds,
        imageRefs: block.image_refs,
        captureMode: block.image_refs.length > 0 ? 'image' : 'text',
        sourceDocumentId: params.sourceDocumentId,
        docUsage: params.docUsage,
        now: params.now,
        generatedBy: provenance,
      },
    });
    return {
      block_id: block.id,
      question_id: questionId,
      attempt_event_id: enroll.attemptEventId,
      record_id: enroll.recordId,
      knowledge_ids: params.knowledgeIds,
      confidence: params.confidence,
      block_version: block.version + 1,
      captured_answer: false,
    };
  });
}
