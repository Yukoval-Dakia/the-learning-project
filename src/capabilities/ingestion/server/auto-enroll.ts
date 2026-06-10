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
import { createHash } from 'node:crypto';

import { createId } from '@paralleldrive/cuid2';
import { and, eq, sql } from 'drizzle-orm';

import {
  type BlockAssemblyRunTaskFn,
  runBlockAssemblyForSession,
} from '@/capabilities/ingestion/server/block-assembly';
import { enrollCapturedBlock } from '@/capabilities/ingestion/server/enroll';
import {
  MistakeEnrollTaskError,
  type RunMistakeEnrollTaskParams,
  runMistakeEnrollTask,
} from '@/capabilities/ingestion/server/mistake_enroll';
import {
  type RunTaggingTaskParams,
  TaggingTaskError,
  runTaggingTask,
} from '@/capabilities/ingestion/server/tagging';
import { runWorkflowJudge } from '@/capabilities/ingestion/server/workflow-judge';
import {
  type FlagEnv,
  autoEnrollEnabled,
  autoEnrollThreshold,
  observeEnabled,
} from '@/capabilities/ingestion/server/workflow-judge-config';
import type { MistakeEnrollOutputT } from '@/core/schema/mistake_enroll';
import { structuredToPromptMarkdown } from '@/core/schema/structured_question';
import type { TaggingOutputT } from '@/core/schema/tagging';
import type { Db } from '@/db/client';
import { learning_session, question, question_block } from '@/db/schema';
import { type WriteEventInput, writeEvent } from '@/server/events/queries';
import { resolveSubjectProfileForKnowledgeIds } from '@/server/knowledge/subject-profile';

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
  /**
   * Inject in tests; defaults to the real `writeEvent`. Used by observe mode to
   * write the per-block audit event. Mirrors `runTaggingFn?` — tests inject a fn
   * that throws for a chosen block to prove per-block observe-write isolation.
   */
  writeEventFn?: (db: Db, input: WriteEventInput) => Promise<string>;
  /**
   * Inject in tests; defaults to the production MistakeEnrollTask invoker. Used
   * in observe mode to draft mistake metadata for ANSWERED blocks (A1, YUK-145).
   */
  runMistakeEnrollFn?: (params: RunMistakeEnrollTaskParams) => Promise<MistakeEnrollOutputT>;
  /**
   * Inject in tests; defaults to the production BlockAssemblyTask invoker
   * (YUK-202, design 2026-06-02 §3). Drives the per-session block-merge proposal
   * pass below — tests pass a fake returning candidates / throwing.
   */
  runBlockAssemblyFn?: BlockAssemblyRunTaskFn;
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

  // ---- Mode resolution (Strategy D Slice B, YUK-190). ----
  // enroll flag ON  → 'enroll' (the original auto-import path, UNCHANGED).
  // enroll OFF + observe ON (the default) → 'observe' (tag+judge, audit-only).
  // enroll OFF + observe OFF → 'off' (the pre-Slice-B hard no-op).
  const mode: 'enroll' | 'observe' | 'off' = autoEnrollEnabled(env)
    ? 'enroll'
    : observeEnabled(env)
      ? 'observe'
      : 'off';
  if (mode === 'off') {
    return { status: 'skipped:flag_off', enrolled: 0, routed_to_review: 0, blocks: [] };
  }

  const threshold = autoEnrollThreshold(env);
  const now = params.now ?? new Date();
  const runTaggingFn = params.runTaggingFn ?? runTaggingTask;
  const writeEventFn = params.writeEventFn ?? writeEvent;
  const runMistakeEnrollFn = params.runMistakeEnrollFn ?? runMistakeEnrollTask;

  // Load the session (must be an ingestion session in an extractable state).
  const sessionRows = await params.db
    .select()
    .from(learning_session)
    .where(and(eq(learning_session.id, params.sessionId), eq(learning_session.type, 'ingestion')));
  const session = sessionRows[0];
  if (!session) {
    return { status: 'skipped:session_not_found', enrolled: 0, routed_to_review: 0, blocks: [] };
  }
  // Auto-enroll runs after extraction, before human review. Both modes share the
  // {extracted, partial} entry gate, BUT enroll mode narrows to 'extracted' only
  // (§8 guard): enroll flips blocks to 'imported', and the manual import guard
  // rejects 'partial' (assertSessionAvailableForImport(['extracted','reviewed'])),
  // so letting enroll act on a 'partial' session would create the YUK-164 #1
  // 409-mismatch the day someone flips the flag. observe acts on both — observing
  // a degraded-layout session is harmless and we want its quality distribution.
  if (session.status !== 'extracted' && session.status !== 'partial') {
    return { status: 'skipped:wrong_status', enrolled: 0, routed_to_review: 0, blocks: [] };
  }
  if (mode === 'enroll' && session.status !== 'extracted') {
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

  // ---- YUK-202 — BlockAssembly path-B per-session merge-proposal pass. ----
  // Runs in BOTH modes ('enroll' + 'observe', i.e. mode !== 'off' which already
  // short-circuited above), AFTER the draft blocks are loaded and BEFORE any
  // enroll import (so blocks are still 'draft' — mergeQuestions on user accept
  // needs draft) (design 2026-06-02 §3). AI ONLY proposes; mergeQuestions runs
  // only on user accept (§5 hard boundary). The AI failure is SWALLOWED + logged
  // — merge proposals are nice-to-have, not the critical path; an outage must
  // NOT flip session state or abort enrollment (mirrors the per-block
  // observe-write fault swallow). observe mode still proposes (zero mutation).
  try {
    await runBlockAssemblyForSession(params.db, {
      sessionId: params.sessionId,
      blocks: blocks.map((b) => ({
        id: b.id,
        structured: b.structured,
        layout_quality: b.layout_quality,
        // YUK-227 S3 Slice A (F4): pass page_spans so projectBlock can include
        // real page_index for VLM-path sessions. Tencent-path blocks carry
        // placeholder page_index=0 which triggers all-placeholder degradation.
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

    // A1/A2 (YUK-145/164): for an ANSWERED block routed 'auto', draft the mistake
    // metadata (outcome / cause) the human fills by hand. Computed ONCE here and
    // shared: observe attaches it to the audit event (A1); enroll enrolls the real
    // outcome from it (A2). Best-effort — a MistakeEnrollTaskError leaves it
    // undefined (observe writes a draft-less event; enroll falls back to
    // 'unanswered'); a non-MistakeEnrollTaskError re-raises (infra fault → retry).
    let mistakeDraft: MistakeEnrollOutputT | undefined;
    const studentAnswer = block.wrong_answer_md?.trim() ?? '';
    if (verdict.route === 'auto' && studentAnswer.length > 0) {
      const profile = await resolveSubjectProfileForKnowledgeIds(
        params.db,
        verdict.prefilled.knowledge_ids,
      );
      try {
        mistakeDraft = await runMistakeEnrollFn({
          questionMd,
          referenceMd: block.reference_md ?? null,
          studentAnswerMd: block.wrong_answer_md ?? null,
          knowledgeIds: verdict.prefilled.knowledge_ids,
          profile,
          ctx: { db: params.db, subjectProfile: profile },
        });
      } catch (err) {
        if (!(err instanceof MistakeEnrollTaskError)) throw err;
        console.error(`[auto_enroll] mistake_enroll draft failed for block ${block.id}`, err);
      }
    }

    // ---- Phase B — OBSERVE (flag OFF, observe ON): write a standalone audit ----
    // event per block (BOTH 'auto' and 'review' routes — we want the full quality
    // distribution) and continue. Zero domain rows, no block UPDATE, no
    // enrollCapturedBlock, no commitImport. Best-effort: a single failed audit
    // write logs + continues so one bad write never aborts the batch (§5.4).
    if (mode === 'observe') {
      try {
        await writeEventFn(params.db, {
          id: observeEventId(params.sessionId, block.id),
          session_id: null,
          actor_kind: 'agent',
          actor_ref: 'workflow_judge',
          action: 'experimental:auto_enroll_observed',
          subject_kind: 'question_block',
          subject_id: block.id,
          outcome: verdict.route === 'auto' ? 'success' : 'skipped',
          payload: {
            generated_by: 'workflow_judge',
            mode: 'observe',
            route: verdict.route,
            confidence: verdict.confidence,
            threshold,
            reasoning: verdict.reasoning,
            extraction_confidence: block.extraction_confidence,
            tagging_overall_confidence: tagging.overall_confidence,
            suggested_knowledge_ids: verdict.prefilled.knowledge_ids,
            ingestion_session_id: params.sessionId,
            ...(mistakeDraft ? { mistake_draft: mistakeDraft } : {}),
          },
          caused_by_event_id: null,
          task_run_id: null,
          cost_micro_usd: null,
          // ★ Memory-outbox OPT-OUT (§3.5): stamping ingest_at non-NULL makes the
          // outbox poller (triggers.ts: WHERE ingest_at IS NULL) skip this row, so
          // no Mem0 `add` / brief-regen fan-out fires for a judge-verdict on the
          // inert OFF path. This is an opt-out of memory ingestion, NOT a claim
          // that ingestion already ran; a future slice that wants verdicts in
          // memory removes this stamp.
          ingest_at: now,
          created_at: now,
        });
      } catch (err) {
        console.error(`[auto_enroll:observe] writeEvent failed for block ${block.id}`, err);
      }
      continue;
    }

    if (verdict.route !== 'auto') {
      routedToReview += 1;
      continue;
    }

    // ---- Auto-enroll this block (one tx, mirrors the human import route). ----
    // A2 (YUK-164): an ANSWERED block enrolls its REAL outcome from the draft
    // (failure/partial/success); an unanswered block (or a draft outage) stays
    // 'unanswered' (item-bank, no attempt) — the safest fallback (slice-3 behavior).
    const outcome = mistakeDraft?.wrong_answer ?? 'unanswered';
    const answerMd = outcome === 'unanswered' ? '' : (block.wrong_answer_md ?? '');
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

      // SAME enrollment owner as the human path — only generatedBy + the (drafted)
      // outcome/answer differ. enrollCapturedBlock routes all 4 outcomes.
      const enroll = await enrollCapturedBlock(tx, {
        questionId,
        outcome,
        answerMd,
        answerImageRefs: [],
        knowledgeIds: verdict.prefilled.knowledge_ids,
        imageRefs: block.image_refs,
        captureMode: block.image_refs.length > 0 ? 'image' : 'text',
        sourceDocumentId,
        now,
        generatedBy: 'workflow_judge',
      });

      // A2: write the drafted cause directly as a chained judge event (mirrors
      // attribute.ts) — only for a failure that produced both an attempt event and
      // a cause. The draft already paid the LLM cost (no AttributionTask re-run);
      // writeEvent stays the single owner (ADR-0005). OC-5 lets the user correct it.
      if (outcome === 'failure' && enroll.attemptEventId && mistakeDraft?.cause) {
        await writeEvent(tx, {
          id: createId(),
          session_id: null,
          actor_kind: 'agent',
          actor_ref: 'workflow_judge',
          action: 'judge',
          subject_kind: 'event',
          subject_id: enroll.attemptEventId,
          outcome: 'success',
          payload: {
            cause: {
              primary_category: mistakeDraft.cause.primary_category,
              secondary_categories: mistakeDraft.cause.secondary_categories,
              analysis_md: mistakeDraft.cause.analysis_md,
              confidence: mistakeDraft.cause.confidence,
            },
            referenced_knowledge_ids: verdict.prefilled.knowledge_ids,
            generated_by: 'workflow_judge',
          },
          caused_by_event_id: enroll.attemptEventId,
          task_run_id: null,
          cost_micro_usd: null,
          created_at: now,
        });
      }

      await tx
        .update(question_block)
        .set({
          imported_question_id: questionId,
          imported_attempt_event_id: enroll.attemptEventId,
          // A2 (D1=C): a distinct terminal-but-revertible state, NOT human 'imported'.
          status: 'auto_enrolled',
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

/**
 * Deterministic event id for an observe-only audit event (Slice B, YUK-190).
 * A stable sha256 of `auto_enroll_observed:${sessionId}:${blockId}` so a pg-boss
 * redelivery / re-run of the `auto_enroll` job writes NO duplicate event
 * (writeEvent's onConflictDoNothing makes the second write a no-op, preserving
 * the already-stamped `ingest_at`). A random cuid would break this idempotency.
 */
export function observeEventId(sessionId: string, blockId: string): string {
  return createHash('sha256').update(`auto_enroll_observed:${sessionId}:${blockId}`).digest('hex');
}
