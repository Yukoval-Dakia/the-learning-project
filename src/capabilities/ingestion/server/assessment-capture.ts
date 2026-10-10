import { and, eq, sql } from 'drizzle-orm';
import { canonicalHash } from '@/core/migration/canonical';
import type { ResponseSetT } from '@/core/schema/assessment';
import { structuredToPromptMarkdown } from '@/core/schema/structured_question';
import type { Db } from '@/db/client';
import { acquireLearningStateWriteLock } from '@/db/learning-state-lock';
import {
  learning_session,
  question,
  question_block,
  question_group_lifecycle,
  question_revision,
} from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { commitFormalAttempt, recordFormalAttemptCapture, saveSubmission } from '@/kernel/judge';
import { withAnswerClass } from '@/kernel/records/answer-class-write';
import { freezeImageEvidence } from '@/kernel/records/assessment-evidence';
import { issueCapturedAssessment } from '@/kernel/records/assessment-issuance';
import { publishQuestionGroupFromRow } from '@/kernel/records/assessment-publication';
import { writeQuestionBlockLifecycleEvent } from '@/kernel/records/question-block-lifecycle-event';
import type { AutoEnrolledBlock } from './auto-enroll';
import { capturedQuestionShape } from './captured-question-shape';
import { enrollCapturedBlock } from './enroll';

type Block = typeof question_block.$inferSelect;
interface CaptureInput {
  block: Block;
  knowledgeIds: string[];
  difficulty: number;
  confidence: number;
  canEnroll: boolean;
  pageRefs: string[];
  now: Date;
}

/** A receipt for existing work; failed/unadmitted scoring cannot roll it back. */
export async function captureIngestionOriginal(db: Db, input: CaptureInput) {
  const { block, now } = input;
  const captureId = canonicalHash({
    session: block.ingestion_session_id,
    block: block.id,
    version: block.version,
  }).slice(0, 40);
  const questionId = `q_capture_${captureId}`;
  const sourceDigest = canonicalHash({
    structured: block.structured,
    prompt: block.extracted_prompt_md,
    reference: block.reference_md,
    answer: block.wrong_answer_md,
    figures: block.figures,
    pages: block.source_asset_ids,
    page_spans: block.page_spans,
    image_refs: block.image_refs,
  });
  return db.transaction(async (tx) => {
    await acquireLearningStateWriteLock(tx);
    const [current] = await tx
      .select()
      .from(question_block)
      .where(eq(question_block.id, block.id))
      .for('update');
    const [session] = await tx
      .select()
      .from(learning_session)
      .where(eq(learning_session.id, block.ingestion_session_id));
    if (
      current?.status !== 'draft' ||
      current.version !== block.version ||
      session?.type !== 'ingestion' ||
      session.status !== 'extracted'
    )
      return null;
    if (input.pageRefs.some((id) => !current.source_asset_ids.includes(id)))
      throw new ApiError(
        'capture_asset_mismatch',
        'answer page is outside the captured block',
        409,
      );
    const [existing] = await tx.select().from(question).where(eq(question.id, questionId));
    if (existing && existing.metadata?.capture_input_digest !== sourceDigest)
      throw new ApiError(
        'capture_conflict',
        'capture identity already binds different originals',
        409,
      );
    if (!existing) {
      await tx.insert(question).values(
        withAnswerClass({
          id: questionId,
          ...capturedQuestionShape(block.structured),
          prompt_md: block.structured
            ? structuredToPromptMarkdown(block.structured)
            : (block.extracted_prompt_md ?? ''),
          reference_md: block.reference_md,
          structured: block.structured,
          figures: block.figures,
          image_refs: block.image_refs,
          knowledge_ids: input.knowledgeIds,
          difficulty: input.difficulty,
          source: session.entrypoint ?? 'vision_paper',
          variant_depth: 0,
          draft_status: 'draft',
          metadata: {
            ingestion_session_id: session.id,
            question_block_id: block.id,
            source_document_id: session.source_document_id,
            capture_block_version: block.version,
            capture_input_digest: sourceDigest,
            source_asset_ids: block.source_asset_ids,
          },
          created_at: now,
          updated_at: now,
          version: 0,
        }),
      );
      await publishQuestionGroupFromRow(tx, {
        rootId: questionId,
        actorRef: 'ingestion:capture',
        now,
      });
    }
    const [lifecycle] = await tx
      .select()
      .from(question_group_lifecycle)
      .where(eq(question_group_lifecycle.group_id, questionId));
    if (!lifecycle?.current_revision_id) throw new Error('capture publication missing');
    const issued = await issueCapturedAssessment(tx, {
      group_id: questionId,
      issuance_id: `iss_capture_${captureId}`,
      now,
      source: { session_id: session.id, block_id: block.id, block_version: block.version },
    });
    if (!('issuance' in issued))
      throw new ApiError(issued.status, 'capture could not bind its revision', 409);
    const [revision] = await tx
      .select()
      .from(question_revision)
      .where(eq(question_revision.revision_id, issued.issuance.binding.revision_id));
    if (!revision) throw new Error('capture revision missing');
    const evidence = await freezeImageEvidence(tx, input.pageRefs);
    const text = block.wrong_answer_md ?? '';
    const slots = revision.response_spec.slots;
    const slot = slots.length === 1 ? slots[0] : undefined;
    const entries: ResponseSetT['entries'] = [];
    // Flat extracted text is only attributable when the contract has a single response.
    if (slot?.kind === 'text') entries.push({ slot_id: slot.slot_id, kind: 'text', text_md: text });
    if (slot?.kind === 'open_response')
      entries.push({ slot_id: slot.slot_id, kind: 'open', text_md: text, evidence });
    if (slot?.kind === 'single_choice' || slot?.kind === 'multi_choice') {
      const labels = text
        .trim()
        .toUpperCase()
        .split(/[\s,，、]+/)
        .filter(Boolean);
      const choices = labels.map((label) =>
        slot.options.find((option) => option.label.toUpperCase() === label),
      );
      if (
        labels.length > 0 &&
        choices.every((option) => option !== undefined) &&
        new Set(choices.map((option) => option?.option_id)).size === choices.length
      ) {
        entries.push({
          slot_id: slot.slot_id,
          kind: 'choice',
          option_ids: choices.flatMap((option) => (option ? [option.option_id] : [])),
        });
      }
    }
    const request = {
      issuance_id: issued.issuance.issuance_id,
      evaluation_group_id: `eg_capture_${captureId}`,
      submission_id: `sub_capture_${captureId}`,
      idempotency_key: `capture:${captureId}`,
      response_set: { entries },
      group_evidence: evidence.map((item) => ({
        evidence: item,
        target: { scope: 'all_units' as const },
      })),
      now,
    };
    const saved = await saveSubmission(tx, { ...request, actorRef: 'ingestion:capture' });
    if (!('submission' in saved))
      throw new ApiError(saved.status, 'capture original was not accepted', 409);
    await recordFormalAttemptCapture(tx, 'ingestion_grading', questionId, saved.submission, null, {
      response_md: text,
      session_id: session.id,
      ingestion: {
        block_id: block.id,
        block_version: block.version,
        source_document_id: session.source_document_id ?? '',
        source_asset_ids: block.source_asset_ids,
        generated_by: 'workflow_judge',
      },
    });
    return {
      request,
      questionId,
      sourceDocumentId: session.source_document_id ?? '',
      knowledgeIds: existing?.knowledge_ids ?? input.knowledgeIds,
      admitted: lifecycle.scoring_admission_state === 'admitted',
    };
  });
}

export async function enrollNativeCapture(
  db: Db,
  input: CaptureInput,
): Promise<AutoEnrolledBlock | null> {
  const captured = await captureIngestionOriginal(db, input);
  if (!captured?.admitted || !input.canEnroll || captured.knowledgeIds.length === 0) return null;
  let enrolled: AutoEnrolledBlock | null = null;
  await commitFormalAttempt(db, 'ingestion_grading', captured.questionId, captured.request, {
    onActivated: async (tx, prepared, attemptId) => {
      const [block] = await tx
        .select()
        .from(question_block)
        .where(eq(question_block.id, input.block.id))
        .for('update');
      const [session] = await tx
        .select()
        .from(learning_session)
        .where(eq(learning_session.id, input.block.ingestion_session_id));
      if (
        block?.status !== 'draft' ||
        block.version !== input.block.version ||
        session?.status !== 'extracted'
      )
        throw new ApiError('capture_superseded', 'block changed before capture activation', 409);
      const coarse = prepared.candidate.result.coarse_outcome;
      if (coarse === 'unsupported')
        throw new ApiError('capture_unresolved', 'capture requires review', 409);
      const record = await enrollCapturedBlock(tx, {
        questionId: captured.questionId,
        nativeAttemptEventId: attemptId,
        outcome: coarse === 'correct' ? 'success' : coarse === 'incorrect' ? 'failure' : 'partial',
        answerMd: input.block.wrong_answer_md ?? '',
        answerImageRefs: input.pageRefs,
        imageRefs: input.block.image_refs,
        knowledgeIds: captured.knowledgeIds,
        captureMode: input.pageRefs.length ? 'image' : 'text',
        sourceDocumentId: captured.sourceDocumentId,
        now: input.now,
        generatedBy: 'workflow_judge',
      });
      await tx
        .update(question)
        .set({ draft_status: 'active', updated_at: input.now })
        .where(eq(question.id, captured.questionId));
      const [updated] = await tx
        .update(question_block)
        .set({
          status: 'auto_enrolled',
          imported_question_id: captured.questionId,
          imported_attempt_event_id: attemptId,
          version: sql`${question_block.version} + 1`,
          updated_at: input.now,
        })
        .where(and(eq(question_block.id, block.id), eq(question_block.version, block.version)))
        .returning({ version: question_block.version });
      await writeQuestionBlockLifecycleEvent(tx, {
        blockId: block.id,
        op: 'set_status',
        status: 'auto_enrolled',
        importedQuestionId: captured.questionId,
        importedAttemptEventId: attemptId,
        nextVersion: updated.version,
        actorKind: 'agent',
        actorRef: 'workflow_judge',
        now: input.now,
      });
      enrolled = {
        block_id: block.id,
        question_id: captured.questionId,
        attempt_event_id: attemptId,
        record_id: record.recordId,
        knowledge_ids: captured.knowledgeIds,
        confidence: input.confidence,
      };
    },
  });
  return enrolled;
}
