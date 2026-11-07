import { createId } from '@paralleldrive/cuid2';
import { and, eq, gt, or } from 'drizzle-orm';
import {
  type BlockAssemblyRunTaskFn,
  runBlockAssemblyForSession,
} from '@/capabilities/ingestion/server/block-assembly';
import type { ColdStartBridgeRunTaskFn } from '@/capabilities/ingestion/server/cold-start-bridge';
import {
  type AttributeIngestionKnowledgeParams,
  attributeIngestionKnowledge,
} from '@/capabilities/ingestion/server/knowledge-attribution';
import { rethrowKnowledgeTagInvariant } from '@/capabilities/ingestion/server/knowledge-namer';
import { runWorkflowJudge } from '@/capabilities/ingestion/server/workflow-judge';
import { AUTO_ENROLL_MAX_BLOCKS_PER_RUN } from '@/capabilities/ingestion/server/workflow-judge-config';
import type { StructuredQuestionT } from '@/core/schema/structured_question';
import type { TaggingOutputT } from '@/core/schema/tagging';
import type { Db } from '@/db/client';
import { acquireLearningStateWriteLock } from '@/db/learning-state-lock';
import { learning_session, question, question_block } from '@/db/schema';
/**
 * WorkflowJudge auto-enroll path.
 *
 * Always on (Owner: "收进题库要的是自动"; there is no off switch). It tags and enrolls
 * at most AUTO_ENROLL_MAX_BLOCKS_PER_RUN draft blocks per delivery; the job re-enqueues
 * with a cursor so a longer page still finishes. The judge confidence is stored as a
 * signal, never used to route: every block with a printed prompt enrolls through the
 * same enrollCapturedBlock owner as the human path (only provenance differs). Blocks
 * without a prompt stay draft. It runs between extraction and review and never closes
 * the session.
 */
import { resolveSessionDerivationPolicy } from '@/kernel/read-models/usage-policy';
import { tagKnowledge } from '@/kernel/records/knowledge-tag';
import { captureIngestionOriginal } from './assessment-capture';
import {
  capturedQuestionShape,
  recordCapturedQuestion,
  settleCapturedBlock,
} from './capture/captured-question';
import { blockHasPrompt, blockQuestionMarkdown } from './capture/question-text';

export type AutoEnrollSkipReason = 'session_not_found' | 'wrong_status';

export interface AutoEnrolledBlock {
  block_id: string;
  question_id: string;
  /** Null for an unanswered (item-bank) enrollment. */
  attempt_event_id: string | null;
  record_id: string;
  confidence: number;
  knowledge_ids: string[];
}

export interface RunAutoEnrollResult {
  status: 'completed' | `skipped:${AutoEnrollSkipReason}`;
  enrolled: number;
  /** Blocks left 'draft' (no usable prompt, or the per-block write failed). */
  routed_to_review: number;
  /** Per-block detail for enrolled blocks. */
  blocks: AutoEnrolledBlock[];
  /**
   * Set when this run consumed a full batch; the caller re-enqueues with this
   * cursor so a page with more blocks than the per-run ceiling still finishes.
   */
  next_after_block: AutoEnrollCursor | null;
}

/** Facts recorded on the question for a block auto-enrolled below the line. */
export interface AutoEnrollmentMarkers {
  enrolled_by: 'workflow_judge';
  knowledge: 'attributed' | 'missing';
  /** Solution annotation is always generated in the background, never inline. */
  solution: 'annotated' | 'missing';
  /** Combined extraction/tagging confidence; a signal, never a gate. */
  confidence: number;
  figures_attached: number;
  student_work: boolean;
}

export interface RunAutoEnrollParams {
  db: Db;
  sessionId: string;
  providerAttempt?: AttributeIngestionKnowledgeParams['providerAttempt'];
  /** Restrict TaggingTask's candidate grid to one subject. */
  subjectId?: string;
  /**
   * Enroll-path tagging. Defaults to `tagKnowledge` (embedding match-or-propose); a throw
   * still enrolls the question with `knowledge: 'missing'`.
   */
  tagKnowledgeFn?: typeof tagKnowledge;
  /** Test seam for the per-session block-merge proposal pass. */
  runBlockAssemblyFn?: BlockAssemblyRunTaskFn;
  /** Naming seam passed to `tagKnowledge`; lets tests reuse a bridge result. */
  runColdStartBridgeFn?: ColdStartBridgeRunTaskFn;
  /** Shared wall-clock for the batch. */
  now?: Date;
  /** Forwarded to runTask ctx (subjectProfile). */
  ctx?: unknown;
  /** Continue after this reading-order position (oversized-session cursor). */
  afterBlock?: { ordinal: number; id: string };
}

export interface AutoEnrollCursor {
  ordinal: number;
  id: string;
}

/** Runs the auto-enroll path for one ingestion session. */
export async function runAutoEnrollForSession(
  params: RunAutoEnrollParams,
): Promise<RunAutoEnrollResult> {
  const now = params.now ?? new Date();
  const tagKnowledgeFn = params.tagKnowledgeFn ?? tagKnowledge;

  // This session must be an ingestion session in an extractable state.
  const sessionRows = await params.db
    .select()
    .from(learning_session)
    .where(and(eq(learning_session.id, params.sessionId), eq(learning_session.type, 'ingestion')));
  const session = sessionRows[0];
  if (!session) {
    return {
      status: 'skipped:session_not_found',
      enrolled: 0,
      routed_to_review: 0,
      blocks: [],
      next_after_block: null,
    };
  }
  // A degraded page layout ('partial') is a block-level fact, not a reason to skip the
  // session (YUK-1994). Blocks with a printed prompt still enroll.
  if (session.status !== 'extracted' && session.status !== 'partial') {
    return {
      status: 'skipped:wrong_status',
      enrolled: 0,
      routed_to_review: 0,
      blocks: [],
      next_after_block: null,
    };
  }

  // Resolve document usage once per run; every enrolled block inherits it instead of
  // paying an unindexed lookup per block.
  const sessionDocUsage = {
    policy: await resolveSessionDerivationPolicy(params.db, params.sessionId),
    sessionId: params.sessionId,
  };
  const sourceDocumentId = session.source_document_id ?? '';
  const sessionEntrypoint = session.entrypoint ?? 'vision_paper';

  // Bound the paid fan-out per delivery. The caller re-enqueues with
  // `next_after_block` when a batch fills, so a long page still completes. The cursor is
  // `(ordinal, id)` — the same total order used for reading adjacency — so no block is
  // skipped when a later batch shares an ordinal with an earlier one.
  const blocks = await params.db
    .select()
    .from(question_block)
    .where(
      and(
        eq(question_block.ingestion_session_id, params.sessionId),
        eq(question_block.status, 'draft'),
        params.afterBlock !== undefined
          ? or(
              gt(question_block.ordinal, params.afterBlock.ordinal),
              and(
                eq(question_block.ordinal, params.afterBlock.ordinal),
                gt(question_block.id, params.afterBlock.id),
              ),
            )
          : undefined,
      ),
    )
    // Adjacency is the array order, so it must be reading order (ordinal), not id.
    .orderBy(question_block.ordinal, question_block.id)
    .limit(AUTO_ENROLL_MAX_BLOCKS_PER_RUN);

  // Block-assembly merge proposals run before any enroll import, while blocks are still
  // draft (mergeQuestions on user accept requires draft). AI only proposes; an outage is
  // logged and swallowed because it must not abort enrollment.
  try {
    await runBlockAssemblyForSession(params.db, {
      sessionId: params.sessionId,
      blocks: blocks.map((b) => ({
        id: b.id,
        structured: b.structured,
        layout_quality: b.layout_quality,
        // page_spans lets projectBlock keep real page_index for VLM-path sessions;
        // Tencent-path blocks carry placeholder page_index=0.
        page_spans: b.page_spans,
      })),
      runTaskFn: params.runBlockAssemblyFn,
      ctx: params.ctx ?? { db: params.db },
    });
  } catch (err) {
    console.error(`[auto_enroll:block_assembly] pass failed for session ${params.sessionId}`, err);
  }

  const enrolled: AutoEnrolledBlock[] = [];
  let routedToReview = 0;

  // One cache per run so siblings proposing the same KC name reuse the first id instead
  // of minting duplicates. The sequential loop below satisfies the cache's contract.
  const tagBatchCache = new Map<string, string>();

  for (const block of blocks) {
    const questionMd = blockQuestionMarkdown(block);
    // "Complete enough to enter the library" means the block carries a printed prompt.
    // Options or a model-written note are not a substitute: an orphan option block stays
    // draft and the response says why (YUK-1994).
    if (!blockHasPrompt(block)) {
      routedToReview += 1;
      continue;
    }

    // This question's pages, falling back to all source assets without page_index. Used
    // for the judge, student images, and stored answer refs to limit inter-page bleed.
    const scopedPageRefs = pageScopedQuestionImageRefs(block);

    // Attribution is a marker, never an enrollment condition (YUK-1994): a failed or
    // empty result still enters the bank and the background backfill repairs it.
    let tagging: TaggingOutputT;
    try {
      const attributed = await attributeIngestionKnowledge({
        db: params.db,
        questionMd,
        knowledgeHint: block.knowledge_hint,
        ...(params.subjectId !== undefined ? { subjectId: params.subjectId } : {}),
        providerAttempt: params.providerAttempt,
        ...(params.runColdStartBridgeFn !== undefined
          ? { runTaskFn: params.runColdStartBridgeFn }
          : {}),
        tagKnowledgeFn,
        batchCache: tagBatchCache,
        sessionId: params.sessionId,
        sourceRef: { kind: 'question_block', id: block.id },
        ctx: params.ctx ?? { db: params.db },
      });
      tagging = synthesizeTaggingOutput(attributed.knowledgeIds);
    } catch (err) {
      rethrowKnowledgeTagInvariant(err);
      // A data-integrity invariant still aborts; ordinary tagging faults (missing
      // seed root, provider outage) leave the question unattributed but enrolled.
      console.error(
        `[auto_enroll] knowledge attribution failed for block ${block.id}; enrolling without knowledge`,
        err,
      );
      tagging = synthesizeTaggingOutput([]);
    }

    // Deterministic confidence signal; it never decides the route.
    const verdict = runWorkflowJudge({
      defaultQuestionKind: capturedQuestionShape(block.structured).kind,
      extractionConfidence: block.extraction_confidence,
      tagging,
    });
    const knowledgeIds = verdict.prefilled.knowledge_ids;
    const markers: AutoEnrollmentMarkers = {
      enrolled_by: 'workflow_judge',
      knowledge: knowledgeIds.length > 0 ? 'attributed' : 'missing',
      solution: 'missing',
      confidence: verdict.confidence,
      figures_attached: block.figures.length,
      student_work: detectStudentWork(block),
    };

    // Captured work keeps its private answer evidence (submission + participation
    // anchor) but is not graded here — scoring is slice 5. The question still enters
    // the item bank like any other block.
    const hasCapturedAnswer = Boolean(block.wrong_answer_md?.trim()) || detectStudentWork(block);
    if (hasCapturedAnswer) {
      try {
        const captured = await captureIngestionOriginal(params.db, {
          block,
          knowledgeIds,
          difficulty: verdict.prefilled.difficulty,
          confidence: verdict.confidence,
          canEnroll: true,
          pageRefs: scopedPageRefs,
          docUsage: sessionDocUsage,
          now,
          enrollmentMetadata: { ...markers },
        });
        if (!captured) {
          routedToReview += 1;
          continue;
        }
        const result = await settleItemBankEnrollment({
          db: params.db,
          block,
          questionId: captured.questionId,
          knowledgeIds: captured.knowledgeIds,
          confidence: verdict.confidence,
          docUsage: sessionDocUsage,
          sourceDocumentId: sourceDocumentId || captured.sourceDocumentId,
          capturedAttemptEventId: captured.attemptEventId,
          now,
        });
        if (result === null) routedToReview += 1;
        else enrolled.push(result);
      } catch (error) {
        console.error(`[auto_enroll:capture] block ${block.id} left draft`, error);
        routedToReview += 1;
      }
      continue;
    }

    // Genuine unanswered material keeps the item-bank path.
    const outcome = 'unanswered' as const;
    const answerMd = '';
    const answerImageRefs: string[] = [];
    const captureMode = block.image_refs.length > 0 ? 'image' : 'text';
    let result: AutoEnrolledBlock | null;
    try {
      result = await params.db.transaction(async (tx) => {
        // Same tx-entry order as every learning-state writer and the cascade revert.
        await acquireLearningStateWriteLock(tx);
        // Concurrent consumers can both pass the draft SELECT above and insert duplicate
        // questions. Re-read this block FOR UPDATE and skip unless it is still draft; this
        // row lock is the structural double-consume guard. Singleton keys only reduce the
        // number of duplicate jobs and do not bear correctness.
        const claimRows = await tx
          .select({ status: question_block.status, version: question_block.version })
          .from(question_block)
          .where(eq(question_block.id, block.id))
          .for('update');
        const [claimSession] = await tx
          .select({ status: learning_session.status })
          .from(learning_session)
          .where(eq(learning_session.id, params.sessionId))
          .limit(1);
        // The row can stay `draft` while the learner edits it (version bump). Enrolling
        // the pre-edit snapshot silently would close the editor's draft with stale
        // content, so the same checks the capture owner runs gate this path too.
        if (
          claimRows[0]?.status !== 'draft' ||
          claimRows[0].version !== block.version ||
          (claimSession?.status !== 'extracted' && claimSession?.status !== 'partial')
        ) {
          return null; // edited or superseded by a concurrent runner
        }

        // Attributed KCs are exactly what tagKnowledge returned pre-tx. Any KC it minted
        // is committed in its own tx, so a rollback here can orphan it; that is benign
        // (valid leaf under the subject root, reconciled by dedup-on-maintenance), and the
        // naming call must never sit inside this transaction.
        const enrollKnowledgeIds = knowledgeIds;

        // Library visibility needs a non-empty prompt and a valid kind. Knowledge ids are
        // deliberately not part of this decision (YUK-1994): an unattributed question
        // enters the bank and is marked for the background knowledge backfill.
        const draftStatus: 'active' | 'draft' =
          questionMd.trim().length > 0 && verdict.prefilled.question_kind.length > 0
            ? 'active'
            : 'draft';

        const questionId = createId();
        await recordCapturedQuestion(tx, {
          questionId,
          sessionId: params.sessionId,
          blockId: block.id,
          sourceDocumentId,
          source: sessionEntrypoint,
          // OCR-extracted answer only; reference generation is out of scope.
          content: { from: 'block', block },
          kind: verdict.prefilled.question_kind,
          knowledgeIds: enrollKnowledgeIds,
          difficulty: verdict.prefilled.difficulty,
          // Placement excludes only 'draft'; null and 'active' both pass.
          draftStatus,
          extraMetadata: {
            // The judge confidence is a signal stored with the question, not a route.
            workflow_judge: {
              confidence: verdict.confidence,
              extraction_confidence: block.extraction_confidence,
              tagging_overall_confidence: tagging.overall_confidence,
              reasoning: verdict.reasoning,
            },
            ingestion_enrollment: markers,
          },
          // A missing OCR answer is withheld; student work goes through the attempt event,
          // never the answer key.
          actorRef: 'auto-enroll:question',
          now,
        });

        // Same enrollment owner as the human path; only provenance and answer differ.
        const enroll = await settleCapturedBlock(tx, {
          transition: 'auto_enroll',
          blockId: block.id,
          guard: { kind: 'version_cas', version: block.version },
          enroll: {
            questionId,
            outcome,
            answerMd,
            answerImageRefs,
            knowledgeIds: enrollKnowledgeIds,
            imageRefs: block.image_refs,
            captureMode,
            sourceDocumentId,
            now,
            generatedBy: 'workflow_judge',
          },
        });

        return {
          block_id: block.id,
          question_id: questionId,
          attempt_event_id: enroll.attemptEventId,
          record_id: enroll.recordId,
          confidence: verdict.confidence,
          knowledge_ids: enrollKnowledgeIds,
        } satisfies AutoEnrolledBlock;
      });
    } catch (error) {
      // One unusable block must not fail the whole page (and burn paid retries);
      // it stays draft for review while the rest of the batch continues.
      console.error(`[auto_enroll:item-bank] block ${block.id} left draft`, error);
      routedToReview += 1;
      continue;
    }

    // A concurrent runner already enrolled this block.
    if (result === null) continue;

    enrolled.push(result);

    // Failure-learning follows from the committed attempt event via the practice-owned
    // durable subscription, so this producer has no queue dependency.
  }

  const last = blocks[blocks.length - 1];
  return {
    status: 'completed',
    enrolled: enrolled.length,
    routed_to_review: routedToReview,
    blocks: enrolled,
    next_after_block:
      blocks.length === AUTO_ENROLL_MAX_BLOCKS_PER_RUN && last !== undefined
        ? { ordinal: last.ordinal, id: last.id }
        : null,
  };
}

/**
 * Links one captured block to the item bank. The capture owner already created and
 * published the question (which enqueues scoring admission); this only flips the block
 * to `auto_enrolled` and marks the question library-visible. No grading is committed.
 */
async function settleItemBankEnrollment(params: {
  db: Db;
  block: typeof question_block.$inferSelect;
  questionId: string;
  knowledgeIds: string[];
  confidence: number;
  docUsage: Parameters<typeof settleCapturedBlock>[1]['enroll']['docUsage'];
  sourceDocumentId: string;
  capturedAttemptEventId?: string;
  now: Date;
}): Promise<AutoEnrolledBlock | null> {
  return params.db.transaction(async (tx) => {
    await acquireLearningStateWriteLock(tx);
    const claimRows = await tx
      .select({ status: question_block.status, version: question_block.version })
      .from(question_block)
      .where(eq(question_block.id, params.block.id))
      .for('update');
    const [claimSession] = await tx
      .select({ status: learning_session.status })
      .from(learning_session)
      .where(eq(learning_session.id, params.block.ingestion_session_id))
      .limit(1);
    if (
      claimRows[0]?.status !== 'draft' ||
      claimRows[0].version !== params.block.version ||
      (claimSession?.status !== 'extracted' && claimSession?.status !== 'partial')
    ) {
      // The block was edited/superseded after the capture committed: leave it draft.
      // The capture question and its attempt event stay as private evidence (draft,
      // not library-visible) and are never linked as an enrollment.
      return null;
    }

    const enroll = await settleCapturedBlock(tx, {
      transition: 'auto_enroll',
      blockId: params.block.id,
      guard: { kind: 'version_cas', version: params.block.version },
      enroll: {
        questionId: params.questionId,
        // No verdict exists yet: the captured work stays evidence, never an answer key
        // and never a fabricated right/wrong bit.
        outcome: 'unanswered',
        capturedAttemptEventId: params.capturedAttemptEventId,
        answerMd: '',
        answerImageRefs: [],
        knowledgeIds: params.knowledgeIds,
        imageRefs: params.block.image_refs,
        captureMode: params.block.image_refs.length > 0 ? 'image' : 'text',
        sourceDocumentId: params.sourceDocumentId,
        docUsage: params.docUsage,
        now: params.now,
        generatedBy: 'workflow_judge',
      },
    });

    await tx
      .update(question)
      .set({ draft_status: 'active', updated_at: params.now })
      .where(eq(question.id, params.questionId));

    return {
      block_id: params.block.id,
      question_id: params.questionId,
      attempt_event_id: enroll.attemptEventId,
      record_id: enroll.recordId,
      confidence: params.confidence,
      knowledge_ids: params.knowledgeIds,
    };
  });
}

/**
 * Adapts tagKnowledge ids to the TaggingOutputT the judge consumes. Attribution is
 * always structurally valid, so every suggestion is full-confidence.
 */
function synthesizeTaggingOutput(knowledgeIds: string[]): TaggingOutputT {
  return {
    suggestions: knowledgeIds.map((id) => ({
      knowledge_id: id,
      confidence: 1,
      reasoning: 'unified tagKnowledge attribution (match or auto-approved propose)',
    })),
    overall_confidence: 1,
    reasoning: 'tagKnowledge: structurally valid attribution',
  };
}

/**
 * Whether the block carries student work, detected from either the Tencent handwriting
 * evidence or the VLM's student_answer_present flag. Pixels stay pixels; this is not a
 * transcription. No structured tree means nothing to detect.
 */
export function detectStudentWork(block: { structured: StructuredQuestionT | null }): boolean {
  const root = block.structured;
  if (!root) return false;
  const stack: StructuredQuestionT[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    if (node.student_answer_present === true) return true;
    const handwriting = node.extraction_evidence?.handwriting;
    if (handwriting && handwriting.length > 0) return true;
    if (node.sub_questions && node.sub_questions.length > 0) {
      for (const sub of node.sub_questions) stack.push(sub);
    }
  }
  return false;
}

/**
 * Narrows the images fed to the judge to the pages this question spans,
 * avoiding cross-page bleed on multi-page uploads. Every page comes from the structured
 * subtree's page_index mapped into source_asset_ids (stored in page order).
 *
 * Falls back to all source assets unless every subtree node has a valid integer
 * page_index in range; a partial or broken signal must never drop the page holding the
 * answer. Known limit: a separate answer-sheet page outside the prompt span is dropped,
 * which surfaces as unsupported/low-confidence and routes to human review.
 */
export function pageScopedQuestionImageRefs(block: {
  structured: StructuredQuestionT | null;
  source_asset_ids: string[];
}): string[] {
  const all = block.source_asset_ids;
  const root = block.structured;
  if (!root || all.length === 0) return all;
  const pages = new Set<number>();
  let totalNodes = 0;
  let nodesWithPage = 0;
  const stack: StructuredQuestionT[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node) continue;
    totalNodes += 1;
    // Number.isInteger, not typeof: jsonb may carry NaN or a float, and NaN would slip
    // the range guard below and map to undefined.
    const pi = node.page_index;
    if (typeof pi === 'number' && Number.isInteger(pi)) {
      pages.add(pi);
      nodesWithPage += 1;
    }
    if (node.sub_questions) {
      for (const sub of node.sub_questions) stack.push(sub);
    }
  }
  // Scope only when every node carries a page_index. Partial population could drop the
  // page holding the answer, so it feeds all pages instead.
  if (pages.size === 0 || nodesWithPage < totalNodes) return all;
  const sorted = [...pages].sort((a, b) => a - b);
  // An out-of-range index makes the page map untrustworthy.

  if (sorted.some((p) => p < 0 || p >= all.length)) return all;
  return sorted.map((p) => all[p]);
}
