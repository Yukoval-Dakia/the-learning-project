/**
 * WorkflowJudge auto-enroll path — T-OC slice 3 (YUK-145, OC-4 / OC-5).
 *
 * See `docs/superpowers/specs/2026-05-29-t-oc-ocr-rebuild-design.md` (OC-4/OC-5) +
 * `docs/superpowers/plans/2026-05-30-yuk145-toc-slice3-lane.md` §5 + ADR-0026.
 *
 * ============================================================================
 * CRITICAL SAFETY — OFF BY DEFAULT. With `WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED`
 * unset (the default), this function short-circuits to a no-op BEFORE any
 * tagging / judging / enrollment. Nothing auto-enrolls; every captured block
 * stays 'draft' for the EXISTING human review flow. Production = today,
 * byte-for-byte. See workflow-judge-config.ts file header.
 * ============================================================================
 *
 * When the flag is explicitly ON: for each 'draft' question_block in the session
 * it runs TaggingTask → WorkflowJudge. Blocks routed 'auto' (high combined
 * confidence) are enrolled WITHOUT human review by INSERTing a `question` and
 * calling `enrollCapturedBlock(tx, { ..., generatedBy: 'workflow_judge' })` (the
 * SAME enrollment owner the human path uses — only the provenance differs).
 * Blocks routed 'review' are left UNTOUCHED ('draft') for the human flow — no
 * behaviour change for them.
 *
 * This runs BETWEEN extraction ('extracted') and human review: it does NOT close
 * the session (no `commitImport`). The human review then handles the remaining
 * draft blocks exactly as before, alongside the auto-enrolled ones.
 *
 * The DEFERRED "AI auto-enrolled N items" review surface (slice 3b) reads the
 * `generated_by='workflow_judge'` event marker to let the user inspect + revert.
 */
import { createId } from '@paralleldrive/cuid2';
import { and, eq, sql } from 'drizzle-orm';

import { structuredToPromptMarkdown } from '@/core/schema/structured_question';
import type { TaggingOutputT } from '@/core/schema/tagging';
import type { Db, Tx } from '@/db/client';
import { learning_session, question, question_block } from '@/db/schema';
import { enrollCapturedBlock } from '@/server/ingestion/enroll';
import {
  type RunTaggingTaskParams,
  TaggingTaskError,
  runTaggingTask,
} from '@/server/ingestion/tagging';
import { runWorkflowJudge } from '@/server/ingestion/workflow-judge';
import {
  type FlagEnv,
  autoEnrollEnabled,
  autoEnrollThreshold,
} from '@/server/ingestion/workflow-judge-config';

export type AutoEnrollSkipReason = 'flag_off' | 'session_not_found' | 'wrong_status';

export interface AutoEnrolledBlock {
  block_id: string;
  question_id: string;
  /** The attempt event id, or null for an unanswered (item-bank) enrollment. */
  attempt_event_id: string | null;
  record_id: string;
  confidence: number;
  knowledge_ids: string[];
}

export interface RunAutoEnrollResult {
  status: 'completed' | `skipped:${AutoEnrollSkipReason}`;
  /** Count of blocks auto-enrolled (0 when skipped or all routed to review). */
  enrolled: number;
  /** Count of blocks the judge routed to human review (left 'draft'). */
  routed_to_review: number;
  /** Per-block detail for the auto-enrolled blocks (evidence / logging). */
  blocks: AutoEnrolledBlock[];
}

export interface RunAutoEnrollParams {
  db: Db;
  sessionId: string;
  /** Restrict TaggingTask's candidate grid to one subject (single-subject default omits). */
  subjectId?: string;
  /** Inject in tests; defaults to the production TaggingTask invoker. */
  runTaggingFn?: (params: RunTaggingTaskParams) => Promise<TaggingOutputT>;
  /** Override env for the flag / threshold reads (tests). */
  env?: FlagEnv;
  /** Shared wall-clock for the batch. */
  now?: Date;
  /** Forwarded to runTask ctx (subjectProfile). */
  ctx?: unknown;
}

/**
 * Runs the gated auto-enroll path for one ingestion session. See file header for
 * the OFF-by-default safety contract.
 */
export async function runAutoEnrollForSession(
  params: RunAutoEnrollParams,
): Promise<RunAutoEnrollResult> {
  const env = params.env ?? process.env;

  // ---- CRITICAL SAFETY GATE: OFF by default → no-op before any work. ----
  if (!autoEnrollEnabled(env)) {
    return { status: 'skipped:flag_off', enrolled: 0, routed_to_review: 0, blocks: [] };
  }

  const threshold = autoEnrollThreshold(env);
  const now = params.now ?? new Date();
  const runTaggingFn = params.runTaggingFn ?? runTaggingTask;

  // Load the session (must be an ingestion session in an extractable state).
  const sessionRows = await params.db
    .select()
    .from(learning_session)
    .where(and(eq(learning_session.id, params.sessionId), eq(learning_session.type, 'ingestion')));
  const session = sessionRows[0];
  if (!session) {
    return { status: 'skipped:session_not_found', enrolled: 0, routed_to_review: 0, blocks: [] };
  }
  // Auto-enroll runs after extraction, before human review.
  if (session.status !== 'extracted' && session.status !== 'partial') {
    return { status: 'skipped:wrong_status', enrolled: 0, routed_to_review: 0, blocks: [] };
  }
  const sourceDocumentId = session.source_document_id ?? '';
  const sessionEntrypoint = session.entrypoint ?? 'vision_paper';

  // Load all draft blocks for the session.
  const blocks = await params.db
    .select()
    .from(question_block)
    .where(
      and(
        eq(question_block.ingestion_session_id, params.sessionId),
        eq(question_block.status, 'draft'),
      ),
    );

  const enrolled: AutoEnrolledBlock[] = [];
  let routedToReview = 0;

  for (const block of blocks) {
    // Render the question text from the structured tree (the canonical source).
    const questionMd = block.structured
      ? structuredToPromptMarkdown(block.structured)
      : (block.extracted_prompt_md ?? '');
    if (questionMd.trim().length === 0) {
      // Nothing to tag → leave for human review.
      routedToReview += 1;
      continue;
    }

    // TaggingTask. A tagging outage must NEVER auto-enroll — route to review.
    let tagging: TaggingOutputT;
    try {
      tagging = await runTaggingFn({
        db: params.db,
        questionMd,
        knowledgeHint: block.knowledge_hint,
        subjectId: params.subjectId,
        ctx: params.ctx,
      });
    } catch (err) {
      if (!(err instanceof TaggingTaskError)) throw err;
      routedToReview += 1;
      continue;
    }

    // Deterministic confidence gate.
    const verdict = runWorkflowJudge({
      extractionConfidence: block.extraction_confidence,
      tagging,
      threshold,
    });

    if (verdict.route !== 'auto') {
      routedToReview += 1;
      continue;
    }

    // ---- Auto-enroll this block (one tx, mirrors the human import route). ----
    const result = await params.db.transaction(async (tx) => {
      const questionId = createId();
      await tx.insert(question).values({
        id: questionId,
        kind: verdict.prefilled.question_kind,
        prompt_md: questionMd,
        reference_md: null,
        knowledge_ids: verdict.prefilled.knowledge_ids,
        difficulty: verdict.prefilled.difficulty,
        source: sessionEntrypoint,
        variant_depth: 0,
        figures: block.figures,
        image_refs: block.image_refs,
        // Carry the structured tree only if prompt_md is regenerable from it
        // (ADR-0002 revision invariant). questionMd is derived from structured,
        // so when structured exists they always match.
        structured: block.structured ?? null,
        metadata: {
          source_document_id: sourceDocumentId,
          ingestion_session_id: params.sessionId,
          question_block_id: block.id,
          // OC-5: surface the judge decision on the question for traceability.
          workflow_judge: {
            route: verdict.route,
            confidence: verdict.confidence,
            reasoning: verdict.reasoning,
          },
        },
        created_at: now,
        updated_at: now,
        version: 0,
      });

      // SAME enrollment owner as the human path — only generatedBy differs.
      const enroll = await enrollCapturedBlock(tx, {
        questionId,
        outcome: verdict.prefilled.outcome,
        answerMd: '',
        answerImageRefs: [],
        knowledgeIds: verdict.prefilled.knowledge_ids,
        imageRefs: block.image_refs,
        captureMode: block.image_refs.length > 0 ? 'image' : 'text',
        sourceDocumentId,
        now,
        generatedBy: 'workflow_judge',
      });

      await tx
        .update(question_block)
        .set({
          imported_question_id: questionId,
          imported_attempt_event_id: enroll.attemptEventId,
          status: 'imported',
          updated_at: now,
          version: sql`${question_block.version} + 1`,
        })
        .where(eq(question_block.id, block.id));

      return {
        block_id: block.id,
        question_id: questionId,
        attempt_event_id: enroll.attemptEventId,
        record_id: enroll.recordId,
        confidence: verdict.confidence,
        knowledge_ids: verdict.prefilled.knowledge_ids,
      } satisfies AutoEnrolledBlock;
    });

    enrolled.push(result);
  }

  return {
    status: 'completed',
    enrolled: enrolled.length,
    routed_to_review: routedToReview,
    blocks: enrolled,
  };
}
