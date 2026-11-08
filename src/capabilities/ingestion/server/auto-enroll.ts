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
import type { TaggingOutputT } from '@/core/schema/tagging';
import type { Db } from '@/db/client';
import { learning_session, question_block } from '@/db/schema';
/**
 * WorkflowJudge auto-enroll path.
 *
 * Always on (Owner: "收进题库要的是自动"; there is no off switch). It tags and enrolls
 * at most AUTO_ENROLL_MAX_BLOCKS_PER_RUN draft blocks per delivery; the job re-enqueues
 * with a cursor so a longer page still finishes. The judge confidence is stored as a
 * signal, never used to route: every block with a printed prompt enrolls through the
 * same item-bank enrollment owner as the human path (only provenance differs). Blocks
 * without a prompt stay draft. It runs between extraction and review and never closes
 * the session.
 */
import { resolveSessionDerivationPolicy } from '@/kernel/read-models/usage-policy';
import { tagKnowledge } from '@/kernel/records/knowledge-tag';
import { readRevertedBlockIds } from './block-revert-state';
import { detectStudentWork, pageScopedQuestionImageRefs } from './capture/block-answer-evidence';
import { capturedQuestionShape } from './capture/captured-question';
import { blockHasPrompt, blockQuestionMarkdown } from './capture/question-text';
import { enrollBlockIntoItemBank } from './item-bank-enrollment';

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

  // Bound the paid fan-out per delivery. The caller re-enqueues with
  // `next_after_block` when a batch fills, so a long page still completes. The cursor is
  // `(ordinal, id)` — the same total order used for reading adjacency — so no block is
  // skipped when a later batch shares an ordinal with an earlier one.
  const selected = await params.db
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

  // A learner-reverted block is draft with a prompt, but must never be re-enrolled by
  // any automatic delivery (retry, batch continuation, or a rescue follow-up). The
  // manual single-block endpoint is the explicit re-entry path.
  const reverted = await readRevertedBlockIds(
    params.db,
    selected.map((block) => block.id),
  );
  const blocks = selected.filter((block) => !reverted.has(block.id));

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
    // A restricted usage policy forbids every model send of this document's content
    // — the bridge, the naming call and the tag embedder alike — so the block still
    // enrolls but stays `knowledge: 'missing'` for the policy-gated backfill.
    let tagging: TaggingOutputT;
    if (sessionDocUsage.policy !== 'allow') {
      tagging = synthesizeTaggingOutput([]);
    } else {
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
      confidence: verdict.confidence,
      figures_attached: block.figures.length,
      student_work: detectStudentWork(block),
    };

    let result: AutoEnrolledBlock | null;
    try {
      result = await enrollBlockIntoItemBank({
        db: params.db,
        block,
        knowledgeIds,
        difficulty: verdict.prefilled.difficulty,
        confidence: verdict.confidence,
        markers,
        sourceDocumentId,
        now,
        generatedBy: 'workflow_judge',
        docUsage: sessionDocUsage,
        pageRefs: scopedPageRefs,
        kind: verdict.prefilled.question_kind,
        draftStatus:
          questionMd.trim().length > 0 && verdict.prefilled.question_kind.length > 0
            ? 'active'
            : 'draft',
        extraMetadata: {
          // The judge confidence is a signal stored with the question, not a route.
          workflow_judge: {
            confidence: verdict.confidence,
            extraction_confidence: block.extraction_confidence,
            tagging_overall_confidence: tagging.overall_confidence,
            reasoning: verdict.reasoning,
          },
        },
      });
    } catch (error) {
      // One unusable block must not fail the whole page (and burn paid retries);
      // it stays draft for review while the rest of the batch continues.
      console.error(`[auto_enroll] block ${block.id} left draft`, error);
      routedToReview += 1;
      continue;
    }
    // A concurrent runner already enrolled this block.
    if (result === null) continue;

    enrolled.push(result);

    // Failure-learning follows from the committed attempt event via the practice-owned
    // durable subscription, so this producer has no queue dependency.
  }

  // Cursor progress is measured on the selected page, not the filtered set: a batch
  // made only of reverted blocks must still advance to the next page slice.
  const last = selected[selected.length - 1];
  return {
    status: 'completed',
    enrolled: enrolled.length,
    routed_to_review: routedToReview,
    blocks: enrolled,
    next_after_block:
      selected.length === AUTO_ENROLL_MAX_BLOCKS_PER_RUN && last !== undefined
        ? { ordinal: last.ordinal, id: last.id }
        : null,
  };
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
