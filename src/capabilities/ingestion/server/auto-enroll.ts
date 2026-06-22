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
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import {
  type BlockAssemblyRunTaskFn,
  runBlockAssemblyForSession,
} from '@/capabilities/ingestion/server/block-assembly';
import {
  ColdStartBridgeError,
  type ColdStartBridgeRunTaskFn,
  runColdStartBridge,
} from '@/capabilities/ingestion/server/cold-start-bridge';
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
  studentAnswerGradingEnabled,
} from '@/capabilities/ingestion/server/workflow-judge-config';
import { applyProposeNew } from '@/capabilities/knowledge/server/proposals';
import { resolveSubjectProfileForKnowledgeIds } from '@/capabilities/knowledge/server/subject-profile';
import type { CoarseOutcomeT } from '@/core/schema/capability';
import type { MistakeEnrollOutputT } from '@/core/schema/mistake_enroll';
import {
  type StructuredQuestionT,
  structuredToPromptMarkdown,
} from '@/core/schema/structured_question';
import type { TaggingOutputT } from '@/core/schema/tagging';
import type { Db } from '@/db/client';
import { knowledge, learning_session, question, question_block } from '@/db/schema';
import {
  type MultimodalDirectImageFetchFn,
  type MultimodalDirectRunTaskFn,
  runMultimodalDirectJudge,
} from '@/server/ai/judges/multimodal-direct-judge';
import type { JudgeQuestionRow } from '@/server/ai/judges/question-contract';
import { type WriteEventInput, writeEvent } from '@/server/events/queries';
import { recordFamilyObservationForAttempt } from '@/server/mastery/personalized-difficulty';
import { getMasteryState, updateThetaForAttempt } from '@/server/mastery/state';
import { withAnswerClass } from '@/server/questions/answer-class-write';
import { KNOWN_SUBJECT_IDS, resolveSubjectProfile } from '@/subjects/profile';

export type AutoEnrollSkipReason = 'flag_off' | 'session_not_found' | 'wrong_status';

/**
 * YUK-482 cut ④ — the graded verdict for one block's student work on the whole
 * page image. `coarse_outcome` ∈ JudgeResultV2's CoarseOutcome
 * (correct/partial/incorrect/unsupported); `confidence` ∈ [0,1]. Produced by the
 * `multimodal_direct` judge (or a test stub) OUTSIDE the enroll tx.
 */
export interface StudentGradeVerdict {
  coarse_outcome: CoarseOutcomeT;
  confidence: number;
}

/**
 * YUK-482 cut ④ — student-answer grading seam (injectable). Defaults to the
 * production `multimodal_direct` judge (`defaultGradeStudentAnswer`). Builds
 * nothing itself — the caller passes a `JudgeQuestionRow` built from the BLOCK's
 * content (pre-tx) plus the whole-page `studentImageRefs` (= block.source_asset_ids)
 * so the photo-only image path runs.
 *
 * CRITICAL (independent review): the default DIRECTLY invokes
 * `runMultimodalDirectJudge` — it does NOT route through the JudgeInvoker /
 * `resolveQuestionJudgeRoute`. Route resolution would only pick `multimodal_direct`
 * when `q.image_refs.length>0 AND the subject profile lists multimodal_direct in
 * preferredRoutes` (today only `physics`), so a wenyan/math/short_answer block
 * resolves to `semantic` → handwriting pixels never looked at. The direct call
 * unconditionally grades the page image, removing the preferredRoutes trap.
 *
 * `subjectId` is the ingestion session's subject (best pre-tx subject signal); the
 * default resolves the SubjectProfile from it (the judge uses the profile but does
 * NOT gate on preferredRoutes). `runTaskFn` / `imageFetchFn` are the
 * `runMultimodalDirectJudge` seams — DB tests inject them to exercise the real
 * default grader without a model or R2.
 */
export type GradeStudentAnswerFn = (params: {
  db: Db;
  question: JudgeQuestionRow;
  studentImageRefs: string[];
  subjectId?: string;
  runTaskFn?: MultimodalDirectRunTaskFn;
  imageFetchFn?: MultimodalDirectImageFetchFn;
  ctx?: unknown;
}) => Promise<StudentGradeVerdict>;

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
  /**
   * YUK-482 Lane A — ColdStartPlacementBridgeTask LLM seam. DB tests inject a stub so
   * the cold-start bridge (subject-classify + reference-answer generation) runs WITHOUT
   * a real model. Defaults to the production runner via runColdStartBridge. Mirrors the
   * image-candidate accept path's `runColdStartBridgeFn` seam (image-candidate-accept.ts).
   */
  runColdStartBridgeFn?: ColdStartBridgeRunTaskFn;
  /**
   * YUK-482 cut ④ — student-answer grading seam. DB tests inject a stub so the
   * whole-page vision judge runs WITHOUT a real model. Defaults to the production
   * `multimodal_direct` judge via a DIRECT `runMultimodalDirectJudge` call
   * (`defaultGradeStudentAnswer`) — NOT the JudgeInvoker / route resolution (see
   * the CRITICAL note on GradeStudentAnswerFn: route resolution would send a
   * non-physics block to `semantic`, ignoring the handwriting). Returns the graded
   * verdict (coarse outcome + confidence) for the student work on the page image.
   * Mirrors the `runColdStartBridgeFn` seam: the LLM call runs OUTSIDE the enroll
   * tx (judge does R2 image fetch + an LLM call). To exercise the REAL default
   * grader model-free, inject `gradeRunTaskFn` / `gradeImageFetchFn` instead.
   */
  gradeStudentAnswerFn?: GradeStudentAnswerFn;
  /**
   * YUK-482 cut ④ — `runMultimodalDirectJudge` runTask seam, threaded to the
   * DEFAULT grader (`defaultGradeStudentAnswer`). DB tests inject a stub so the
   * REAL default grader runs the vision judge WITHOUT a model — proving the
   * vision judge actually fires on the page image (the class of defect a
   * `gradeStudentAnswerFn` stub can't catch). Ignored when `gradeStudentAnswerFn`
   * is injected (the stub replaces the whole grader). Defaults to the production
   * `runTask`.
   */
  gradeRunTaskFn?: MultimodalDirectRunTaskFn;
  /**
   * YUK-482 cut ④ — `runMultimodalDirectJudge` R2 image-fetch seam, threaded to
   * the DEFAULT grader. DB tests inject a stub so the real grader skips R2.
   * Ignored when `gradeStudentAnswerFn` is injected. Defaults to the production
   * `defaultImageFetch`.
   */
  gradeImageFetchFn?: MultimodalDirectImageFetchFn;
  /**
   * YUK-482 cut ④ — attribution_followup enqueue seam. DB tests inject a vi.fn()
   * to assert the SAME job the human import route enqueues fires for a graded
   * FAILURE. Defaults to the production pg-boss send (gated on
   * shouldEnqueueBackgroundJobs()).
   */
  enqueueAttributionFollowupFn?: (attemptEventId: string) => Promise<void>;
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
  // YUK-482 cut ④ — student-answer grading is a SEPARATE opt-in knob (independent
  // of the auto-enroll flag). It only acts in enroll mode (it writes durable
  // learning data). When OFF (the default), detectStudentWork is never consulted →
  // the per-block flow below is byte-for-byte today's text-draft path.
  const studentGrading = mode === 'enroll' && studentAnswerGradingEnabled(env);
  const gradeStudentAnswerFn = params.gradeStudentAnswerFn ?? defaultGradeStudentAnswer;
  const enqueueAttributionFollowupFn =
    params.enqueueAttributionFollowupFn ?? defaultEnqueueAttributionFollowup;

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

    // ---- YUK-482 cut ④ — student-answer grading (OUTSIDE the tx). ----
    // When the flag is ON and the block carries student work (handwriting / a VLM
    // student_answer_present signal), grade the WHOLE PAGE IMAGE via the existing
    // multimodal_direct judge BEFORE any tagging/enroll. The judge does an R2 image
    // fetch + an LLM call, so — like the cold-start bridge — it MUST run outside the
    // DB transaction; the resulting verdict is stashed and consumed at the enroll
    // site below. Handwriting stays PIXELS (answer_md:'' + whole-page
    // student_image_refs = the photo-only image path; NEVER OCR-transcribed).
    //
    // YUK-485 needs-review gate (dense-page attribution bleed): when the verdict is
    // unconfident (confidence < threshold) OR the route could not grade
    // (coarse_outcome === 'unsupported'), do NOT synthesize a graded attempt —
    // route to human review (block stays 'draft'), mirroring the review-routing
    // below. This keeps dense-page bleed out of mastery / 错因.
    let studentGradeVerdict: StudentGradeVerdict | null = null;
    if (studentGrading && detectStudentWork(block)) {
      // Build the judge row from the BLOCK's content (available pre-tx) — NOT a
      // persisted question row. image_refs = the prompt figures (NOT the student
      // work); the student work is fed via studentImageRefs = source_asset_ids.
      const judgeQuestion: JudgeQuestionRow = {
        id: block.id,
        kind: block.structured?.kind ?? 'short_answer',
        prompt_md: questionMd,
        reference_md: block.reference_md ?? null,
        rubric_json: null,
        choices_md: null,
        judge_kind_override: null,
        knowledge_ids: null,
        metadata: null,
        figures: block.figures,
        image_refs: block.image_refs,
        structured: block.structured ?? null,
      };
      try {
        studentGradeVerdict = await gradeStudentAnswerFn({
          db: params.db,
          question: judgeQuestion,
          // Whole page image = the student's answer photo (cut ④ grades the whole
          // page, no figure/bbox cropping). source_asset_ids carries the page assets.
          studentImageRefs: block.source_asset_ids,
          // Best pre-tx subject signal = the ingestion session's subject (the
          // grader resolves the SubjectProfile from it; the vision judge uses the
          // profile but does NOT gate on preferredRoutes — see GradeStudentAnswerFn).
          subjectId: params.subjectId,
          // runMultimodalDirectJudge seams (ignored when a stub gradeStudentAnswerFn
          // is injected; threaded so the REAL default grader is testable model-free).
          runTaskFn: params.gradeRunTaskFn,
          imageFetchFn: params.gradeImageFetchFn,
          ctx: params.ctx ?? { db: params.db },
        });
      } catch (err) {
        // A grading outage must NEVER synthesize an attempt — route to review.
        console.error(`[auto_enroll:student_grade] judge failed for block ${block.id}`, err);
        routedToReview += 1;
        continue;
      }
      if (
        studentGradeVerdict.coarse_outcome === 'unsupported' ||
        studentGradeVerdict.confidence < threshold
      ) {
        // YUK-485 gate: unconfident / ungradable → human review, block stays draft.
        routedToReview += 1;
        continue;
      }
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

    // ---- YUK-482 Lane A — cold-start bridge gate (Option C, architect-confirmed). ----
    // The judge routes 'auto' ONLY when tagging produced ≥1 surviving suggestion
    // (workflow-judge.ts:64-65), so on a thin-seed tree (only seed:<subject>:root nodes,
    // YUK-477) the grid anti-hallucination filter empties suggestions → route='review'
    // with reasoning "no surviving knowledge suggestions" → the block would drop to the
    // human review pool and NEVER become placement-answerable (placement-select.ts requires
    // knowledge_ids @> [kc]). The cold-start SIGNATURE is exactly this: enroll mode +
    // high-confidence extraction + zero surviving KC match. When it matches, run ONE LLM
    // pass (runColdStartBridge: ① classify into a KNOWN_SUBJECT_ID + name a child concept,
    // ③ generate a reference answer) and stage a child-KC create under seed:<subject>:root
    // for the enroll tx below — mirroring image-candidate-accept.ts:614-658. We do NOT
    // mutate runWorkflowJudge (it stays a pure deterministic aggregator); we redirect at
    // the call site. The bridge LLM call runs HERE, OUTSIDE the tx (no long model call in a
    // DB transaction). Anything that is NOT this signature (low confidence, a non-cold
    // review, or a bridge failure) falls through to the unchanged review path.
    let coldStartKcName: string | null = null;
    let coldStartSubjectRootId: string | null = null;
    let coldStartReferenceMd: string | null = null;
    const isColdStartSignature =
      mode === 'enroll' &&
      verdict.route !== 'auto' &&
      verdict.prefilled.knowledge_ids.length === 0 &&
      verdict.confidence >= threshold;
    if (isColdStartSignature) {
      try {
        const bridge = await runColdStartBridge({
          db: params.db,
          questionMd,
          // The block's OCR-extracted reference answer, when present (echoed by the bridge);
          // null → the bridge GENERATES one. Mirrors image-accept's block.reference_md feed.
          existingReferenceMd: block.reference_md,
          knowledgeHint: block.knowledge_hint,
          knownSubjectIds: KNOWN_SUBJECT_IDS,
          runTaskFn: params.runColdStartBridgeFn,
          ctx: params.ctx ?? { db: params.db },
        });
        coldStartKcName = bridge.kc_name;
        // subject_id is validated ∈ KNOWN_SUBJECT_IDS by the invoker; seed root id is
        // literally seed:<subjectId>:root (YUK-477 stable seed).
        const candidateRootId = `seed:${bridge.subject_id}:root`;
        // LOW fix — missing-seed-root guard. Membership in KNOWN_SUBJECT_IDS does NOT
        // guarantee a PLANTED seed root (a subject can be in the vocabulary while its
        // seed:<subject>:root node was never inserted). applyProposeNew → assertParentExists
        // throws a PLAIN Error on a missing/archived parent; inside the enroll tx that throw
        // escapes and aborts the WHOLE enroll batch → pg-boss retries the job forever (the
        // root never appears, so it never recovers). Pre-check the root HERE (outside the tx)
        // so a missing root routes-to-review (block stays 'draft', upload not lost) — the same
        // best-effort swallow contract as the bridge-failure branch below, not a throw.
        const rootRows = await params.db
          .select({ id: knowledge.id })
          .from(knowledge)
          .where(and(eq(knowledge.id, candidateRootId), isNull(knowledge.archived_at)))
          .limit(1);
        if (rootRows.length === 0) {
          // Leave coldStartKcName null + root unstaged so this falls through to the line-below
          // review path (routedToReview += 1; block stays 'draft'). No throw → the enroll batch
          // continues; the upload is preserved for human review instead of being lost to a
          // pg-boss retry loop.
          coldStartKcName = null;
          console.error(
            `[auto_enroll] cold-start seed root ${candidateRootId} not planted for block ${block.id}; routing to review`,
          );
        } else {
          coldStartSubjectRootId = candidateRootId;
          // ③ Reference-answer precedence (MEDIUM-2): NEVER overwrite a real OCR-extracted
          // answer with the LLM's. Prefer the block's OCR reference_md when present; the bridge
          // answer is the judge anchor ONLY when OCR got none. Mirrors image-candidate-accept.ts
          // (referenceMd already-non-empty short-circuit, :639-643).
          coldStartReferenceMd = block.reference_md?.trim()
            ? block.reference_md
            : bridge.reference_md.trim().length > 0
              ? bridge.reference_md
              : null;
        }
      } catch (bridgeErr) {
        // Best-effort: a provider outage / unparseable output must NOT lose the block. Fall
        // through to the normal review path (block stays 'draft') — same swallow contract as
        // image-candidate-accept.ts:648-657 and the slice-3 review fallback.
        if (!(bridgeErr instanceof ColdStartBridgeError)) throw bridgeErr;
        console.error(
          `[auto_enroll] cold-start bridge failed for block ${block.id}; routing to review`,
          bridgeErr,
        );
      }
    }

    // Not 'auto' AND no cold-start KC staged → the unchanged review path. (A non-cold
    // review, or a cold-start bridge that failed/was skipped: leave 'draft'.)
    if (verdict.route !== 'auto' && coldStartKcName === null) {
      routedToReview += 1;
      continue;
    }

    // ---- MEDIUM-2 (independent review) — graded attempt MUST be mastery-attributable. ----
    // The student-grade gate and the cold-start gate are independent, so a
    // student-graded block could reach enroll with ZERO attributable KCs (a tagging
    // outcome that survives the route gate but yields no knowledge ids, and no
    // cold-start KC minted). If we enrolled it, the `enrollKnowledgeIds.length>0` θ̂
    // guard below would silently skip mastery while the graded attempt + 错因 are
    // still written → an asymmetric attempt-without-mastery row. A graded verdict
    // that cannot be attributed to any KC belongs in HUMAN review, consistent with
    // the YUK-485 needs-review philosophy: route to review (block stays 'draft')
    // rather than synthesizing a half-enrolled graded attempt. The pre-tx
    // attributable count is 1 for a cold-start enroll (KC minted in-tx) else the
    // judge's surviving suggestions (non-empty whenever route==='auto'). The normal
    // (non-graded) auto / cold-start path is UNCHANGED — this only gates the graded path.
    const attributableKcCount =
      coldStartKcName !== null ? 1 : verdict.prefilled.knowledge_ids.length;
    if (studentGradeVerdict && attributableKcCount === 0) {
      routedToReview += 1;
      continue;
    }

    // ---- Auto-enroll this block (one tx, mirrors the human import route). ----
    // A2 (YUK-164): an ANSWERED block enrolls its REAL outcome from the draft
    // (failure/partial/success); an unanswered block (or a draft outage) stays
    // 'unanswered' (item-bank, no attempt) — the safest fallback (slice-3 behavior). A
    // cold-start enroll has no mistakeDraft (that path is gated on route==='auto', and the
    // cold KC has no prior attempt), so it stays 'unanswered' = item-bank — matching the
    // judge's outcome:'unanswered' contract (workflow-judge.ts:79).
    const isColdStartEnroll = coldStartKcName !== null;
    // YUK-482 cut ④ — on the STUDENT-GRADED path the outcome comes from the vision
    // verdict (graded OUTSIDE the tx, above) and the answer IS the whole page image
    // (handwriting stays pixels: answerMd:'' + answerImageRefs = source_asset_ids,
    // captureMode:'image'). This REPLACES the text-draft triplet ONLY here; the
    // normal auto path is unchanged (outcome from mistakeDraft / 'unanswered').
    // Capture a non-null const so TS narrows it inside the tx closure below.
    const gradedVerdict = studentGradeVerdict;
    const outcome = gradedVerdict
      ? gradeOutcomeFromVerdict(gradedVerdict.coarse_outcome)
      : (mistakeDraft?.wrong_answer ?? 'unanswered');
    const answerMd = gradedVerdict
      ? ''
      : outcome === 'unanswered'
        ? ''
        : (block.wrong_answer_md ?? '');
    const answerImageRefs = gradedVerdict ? block.source_asset_ids : [];
    const captureMode: 'text' | 'image' = gradedVerdict
      ? 'image'
      : block.image_refs.length > 0
        ? 'image'
        : 'text';
    const result = await params.db.transaction(async (tx) => {
      // ---- YUK-482 cold-start bridge ① — create the child KC + attribute the question. ----
      // applyProposeNew inserts an approved child under the subject root (domain:null →
      // inherits the subject via the parent chain, so it resolves into the subject subgraph
      // for placement) and asserts the parent exists (pre-checked OUTSIDE the tx — see the
      // missing-root guard at the cold-start signature block above). Done INSIDE the tx so
      // the KC + question + audit-trail commit atomically.
      //
      // Cold-start review gate = AUTO-CREATE LIVE + AUDIT TRAIL (owner-approved, YUK-482): the
      // KC must be live & usable day-one (no manual review wall) BUT must leave a VISIBLE trail
      // that it was AI-auto-created from a cold-start upload — so it is correctable later.
      //
      // HIGH fix (independent review): the trail must NEVER surface as a pending/acceptable
      // proposal and must NEVER enable a re-apply. Earlier this wrote a `propose_new`
      // propose-event via writeKnowledgeProposeEvent — but that event has outcome:'partial'
      // with no chained rate, so inbox.ts resolveStatus → 'pending'; it would surface in
      // GET /api/knowledge/proposals?status=pending, and accepting it would run applyProposeNew
      // AGAIN → a SECOND duplicate KC under the same root (the KC is already created live by
      // the direct applyProposeNew below). The mirror (image-candidate-accept.ts) writes NO
      // propose-event at all for its cold-start KC, exactly to avoid this.
      //
      // Chosen mechanism (brief's PREFERRED "audit-only event"): write a PLAIN event with a
      // DISTINCT action `experimental:cold_start_kc_created`. proposalWhere() (inbox.ts:176-187)
      // only folds `action='propose'`, `experimental:knowledge_%`, `experimental:proposal`, and
      // `experimental:propose_learning_intent` into the proposal inbox — a generic
      // `experimental:cold_start_*` action matches NONE, so it appears in the event log /
      // history but is NEVER an inbox action item, has NO acceptProposal codepath, and cannot
      // re-apply. ExperimentalEvent (experimental.ts) accepts any non-reserved experimental
      // action with a loose record payload, so parseEvent passes.
      let enrollKnowledgeIds = verdict.prefilled.knowledge_ids;
      if (coldStartKcName && coldStartSubjectRootId) {
        const newKcId = await applyProposeNew(tx, {
          mutation: 'propose_new',
          name: coldStartKcName,
          parent_id: coldStartSubjectRootId,
        });
        enrollKnowledgeIds = [newKcId];
        // Audit-only provenance: NOT a proposal (distinct action → never pending, never
        // acceptable, no re-apply). Records the already-applied KC id for later inspection.
        await writeEvent(tx, {
          id: createId(),
          session_id: null,
          actor_kind: 'agent',
          actor_ref: 'workflow_judge',
          action: 'experimental:cold_start_kc_created',
          subject_kind: 'knowledge',
          subject_id: newKcId,
          outcome: 'success',
          payload: {
            source: 'cold_start_bridge',
            auto_created_kc_id: newKcId,
            subject_id: coldStartSubjectRootId,
            parent_id: coldStartSubjectRootId,
            name: coldStartKcName,
            ingestion_block_id: block.id,
            ingestion_session_id: params.sessionId,
            generated_by: 'workflow_judge',
            reasoning: `cold-start bridge auto-created KC for ingestion block ${block.id} (no live KC matched the thin-seed tree); auto-approved day-one, applied as ${newKcId}`,
          },
          caused_by_event_id: null,
          task_run_id: null,
          cost_micro_usd: null,
          created_at: now,
        });
      }

      // ---- MEDIUM-1 — structural-verify gate for the cold-start draft_status. ----
      // Mirrors image-candidate-accept.ts:759-772: a cold-start question is structurally
      // sound (→ 'active') only when it has a non-empty prompt AND a valid (truthy) kind AND
      // ≥1 LIVE (non-archived) KC equal to the attributed-id count. ENFORCE the contract
      // instead of force-flipping 'active'. In the happy path (bridge created exactly one
      // live KC, prompt non-empty, valid kind) it is 'active' as before; but a structurally
      // incomplete cold-start row (e.g. the bridge attributed an id that resolves to no live
      // KC) can no longer be silently forced active — it lands 'draft' for human review.
      let coldStartDraftStatus: 'active' | 'draft' | undefined;
      if (isColdStartEnroll) {
        let liveKnowledgeCount = 0;
        if (enrollKnowledgeIds.length > 0) {
          const liveKnowledge = await tx
            .select({ id: knowledge.id })
            .from(knowledge)
            .where(and(inArray(knowledge.id, enrollKnowledgeIds), isNull(knowledge.archived_at)));
          liveKnowledgeCount = liveKnowledge.length;
        }
        const structurallyVerified =
          questionMd.trim().length > 0 &&
          Boolean(verdict.prefilled.question_kind) &&
          liveKnowledgeCount === enrollKnowledgeIds.length &&
          liveKnowledgeCount > 0;
        coldStartDraftStatus = structurallyVerified ? 'active' : 'draft';
      }

      const questionId = createId();
      await tx.insert(question).values(
        withAnswerClass({
          id: questionId,
          kind: verdict.prefilled.question_kind,
          prompt_md: questionMd,
          // YUK-482 — carry the bridge-generated reference answer (the judge anchor) for a
          // cold-start enroll; null for the normal auto path (unchanged).
          reference_md: coldStartReferenceMd,
          knowledge_ids: enrollKnowledgeIds,
          difficulty: verdict.prefilled.difficulty,
          source: sessionEntrypoint,
          variant_depth: 0,
          figures: block.figures,
          image_refs: block.image_refs,
          // Carry the structured tree only if prompt_md is regenerable from it
          // (ADR-0002 revision invariant). questionMd is derived from structured,
          // so when structured exists they always match.
          structured: block.structured ?? null,
          // YUK-482 — cold-start draft_status from the structural-verify gate above
          // ('active' when prompt + valid kind + ≥1 live KC; else 'draft'). placement-select.ts
          // excludes only draft_status='draft' (NULL and 'active' both pass), so an 'active'
          // cold-start row is immediately placement-answerable. The normal auto path stays
          // undefined (NULL≡active, allowlisted). Setting it explicitly here makes the
          // placement-visibility contract line-of-sight at the INSERT site (image-accept sets
          // it explicitly too); the audit:draft-status gate silently passes an
          // allowlisted-AND-explicit file.
          draft_status: coldStartDraftStatus,
          metadata: {
            source_document_id: sourceDocumentId,
            ingestion_session_id: params.sessionId,
            question_block_id: block.id,
            // OC-5: surface the judge decision on the question for traceability. For a
            // cold-start enroll the judge ROUTED 'review' (no surviving KC), but the question
            // was materialized via the cold-start bridge — so record an explicit
            // route:'cold_start' decision so the traceability record is not self-contradictory
            // (route:'review' alongside cold_start_bridge:true read as a contradiction). The
            // raw judge route stays available as judge_route for the full picture.
            workflow_judge: {
              route: isColdStartEnroll ? 'cold_start' : verdict.route,
              judge_route: verdict.route,
              confidence: verdict.confidence,
              reasoning: verdict.reasoning,
              // YUK-482 cut ④ — traceability for a student-graded enroll: mark that
              // the whole page image was vision-graded + the graded confidence (the
              // YUK-485 gate above already enforced confidence >= threshold). Absent
              // (→ undefined) on the normal auto / cold-start path so the metadata
              // shape is unchanged for them.
              ...(gradedVerdict
                ? {
                    student_answer_graded: true,
                    student_grade_confidence: gradedVerdict.confidence,
                    student_grade_outcome: gradedVerdict.coarse_outcome,
                  }
                : {}),
            },
            // YUK-482 — mark the cold-start provenance so the row is traceable.
            ...(isColdStartEnroll ? { cold_start_bridge: true } : {}),
          },
          created_at: now,
          updated_at: now,
          version: 0,
        }),
      );

      // SAME enrollment owner as the human path — only generatedBy + the (drafted)
      // outcome/answer differ. enrollCapturedBlock routes all 4 outcomes.
      const enroll = await enrollCapturedBlock(tx, {
        questionId,
        outcome,
        answerMd,
        // YUK-482 cut ④ — the student-graded path passes the whole-page asset ids as
        // the answer images (handwriting stays pixels); the normal auto path passes
        // [] (unchanged). captureMode is 'image' for a student-graded enroll.
        answerImageRefs,
        knowledgeIds: enrollKnowledgeIds,
        imageRefs: block.image_refs,
        captureMode,
        sourceDocumentId,
        now,
        generatedBy: 'workflow_judge',
      });

      // ---- YUK-482 cut ④ — mastery (θ̂) for the student-graded attempt. ----
      // enrollCapturedBlock writes the attempt + record but does NOT touch θ̂ (the
      // live paper path does it separately at paper-submit.ts:640). Add it here ONLY
      // for the student-graded path, keyed on the question's primary KC (the
      // attributed enrollKnowledgeIds — the bridge-created KC for a cold-start enroll,
      // else the judge's prefilled suggestions). Mirrors paper-submit's call shape:
      // outcome success/partial → 1, failure → 0 (partial≈success evidence, conservative
      // — same as paper-submit.ts:643). No responseTimeMs (no RT on the ingestion path).
      // Skipped for an unanswered enroll (no attempt event) and the normal text path.
      if (gradedVerdict && enroll.attemptEventId && enrollKnowledgeIds.length > 0) {
        const familyPrimaryKnowledgeId = enrollKnowledgeIds[0];
        // PRE-attempt θ̂ for the family primary KC — captured BEFORE
        // updateThetaForAttempt moves mastery_state.theta_hat to the POSTERIOR
        // (mirror paper-submit.ts:636-638). The family residual must anchor on the
        // answer-time θ̂; reading it after would bias the residual.
        const familyThetaBefore = familyPrimaryKnowledgeId
          ? ((await getMasteryState(tx, familyPrimaryKnowledgeId))?.theta_hat ?? 0)
          : 0;

        await updateThetaForAttempt(tx, {
          knowledgeIds: enrollKnowledgeIds,
          questionId,
          outcome: outcome === 'failure' ? 0 : 1,
          difficulty: verdict.prefilled.difficulty,
          attemptEventId: enroll.attemptEventId,
          now,
          // family delta composition (paper-submit precedent) — keyed on the question's
          // canonical primary KC (enrollKnowledgeIds[0], which IS this question's
          // knowledge_ids[0] at insert above).
          kind: verdict.prefilled.question_kind,
          source: sessionEntrypoint,
          familyPrimaryKnowledgeId,
        });

        // MEDIUM-1 (independent review) — family b_personalized sibling. Both live
        // attempt paths (paper-submit.ts:685, practice/api/submit.ts:673) call
        // recordFamilyObservationForAttempt in the same tx alongside
        // updateThetaForAttempt; cut ④ omitted it. Add it for parity, SAVEPOINT-
        // isolated + best-effort exactly as paper-submit does it: the family write
        // running on the outer tx can poison it (25P02) on any DB-level error
        // (advisory-lock serialization, 23505 first-insert race, malformed-jsonb
        // cast) → the whole enroll tx would roll back. tx.transaction(...) becomes a
        // SAVEPOINT so a family-write failure rolls back only the savepoint; the
        // committed attempt survives. NOTE: judgeRoute='multimodal_direct' is NOT an
        // objective route (OBJECTIVE_JUDGE_ROUTES = exact/keyword), so the hook
        // early-returns (NO-OP) — impact is bounded, but the call parity matters and
        // the route is recorded honestly. partial also early-returns inside the hook.
        try {
          await tx.transaction(async (sp) => {
            await recordFamilyObservationForAttempt(sp, {
              primaryKnowledgeId: familyPrimaryKnowledgeId,
              questionId,
              kind: verdict.prefilled.question_kind,
              source: sessionEntrypoint,
              difficulty: verdict.prefilled.difficulty,
              outcome: outcome === 'failure' ? 0 : 1,
              attemptOutcome: outcome === 'unanswered' ? undefined : outcome,
              // The student-graded path runs the multimodal_direct vision judge
              // directly (defaultGradeStudentAnswer) — record that route verbatim.
              judgeRoute: 'multimodal_direct',
              thetaBefore: familyThetaBefore,
              now,
            });
          });
        } catch (err) {
          console.warn(
            `[auto_enroll:student_grade] recordFamilyObservationForAttempt failed (non-fatal) for block ${block.id}:`,
            err,
          );
        }
      }

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
        // The actually-attributed set: the bridge-created KC for a cold-start enroll,
        // else the judge's prefilled suggestions (unchanged for the normal auto path).
        knowledge_ids: enrollKnowledgeIds,
      } satisfies AutoEnrolledBlock;
    });

    enrolled.push(result);

    // ---- YUK-482 cut ④ — 错因 (attribution) for a student-graded FAILURE. ----
    // Enqueue the SAME attribution_followup job the human import route uses
    // (import.ts:506) so the async attribution agent supersedes the placeholder
    // cause for a graded wrong answer. Only the student-graded FAILURE path needs it
    // (the normal auto path with a mistakeDraft.cause writes its own chained judge
    // event in-tx above; success/partial/unanswered have no failure cause to
    // attribute). Runs AFTER the tx commits (boss.send is an external side-effect;
    // mirrors import.ts which sends after the writes commit) — best-effort, never
    // aborts the committed enroll.
    if (gradedVerdict && outcome === 'failure' && result.attempt_event_id) {
      await enqueueAttributionFollowupFn(result.attempt_event_id);
    }
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

/**
 * YUK-482 cut ④ — does this block carry student work? OR-based across two signals
 * so the Tencent path works even without the VLM flag:
 *   - Tencent path: any node in the structured tree has a non-empty
 *     `extraction_evidence.handwriting` (stamped at tencent_mark_parser.ts:298).
 *   - VLM path: any node has `student_answer_present === true` (emitted by the
 *     StructureTask prompt; NEVER a transcription — pixels stay pixels).
 * Walks the recursive tree (stem → sub_questions). A block with no structured tree
 * → false (nothing to detect on; the human review path is unchanged).
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
 * YUK-482 cut ④ — map the vision judge's coarse outcome → the EnrollOutcome the
 * 错因/mastery chains consume. Mirrors paper-submit.ts:275-276
 * (correct→success, partial→partial, else→failure). `unsupported` is gated out
 * upstream (YUK-485) so it never reaches here on the graded path.
 */
function gradeOutcomeFromVerdict(coarse: CoarseOutcomeT): 'success' | 'partial' | 'failure' {
  if (coarse === 'correct') return 'success';
  if (coarse === 'partial') return 'partial';
  return 'failure';
}

/**
 * YUK-482 cut ④ — production student-answer grader.
 *
 * CRITICAL (independent review) — calls `runMultimodalDirectJudge` DIRECTLY,
 * bypassing the JudgeInvoker / `resolveQuestionJudgeRoute`. The resolver only
 * picks `multimodal_direct` when the question carries prompt figures AND the
 * subject profile lists `multimodal_direct` in `preferredRoutes` (today only
 * `physics`); a wenyan/math/short_answer block would resolve to `semantic`, which
 * ignores `student_image_refs` and judges an empty `answer_md` → the handwriting
 * pixels are never looked at. Cut ④ grades PER-QUESTION (no part-narrowing — that
 * is YUK-485, out of scope), so the invoker's `part_ref` narrowing is not needed
 * and the direct call is both correct and simpler. The call still honors the
 * global / per-judge provider selection via `runMultimodalDirectJudge`'s own
 * `runTask` (cut ③ model routing untouched).
 *
 * `answer_md:''` + whole-page `student_image_refs` (= block.source_asset_ids) runs
 * the photo-only image path (handwriting stays pixels — never OCR-transcribed).
 *
 * SubjectProfile: resolved from the best pre-tx subject signal — the ingestion
 * session's subject (`params.subjectId`) when reachable, else the block's
 * `knowledge_hint`-derived KCs (none pre-tx → the helper falls back to general).
 * The judge USES the profile (e.g. for the prompt's subject hint) but does NOT
 * gate on `preferredRoutes`, so whatever profile resolves is safe.
 */
async function defaultGradeStudentAnswer(params: {
  db: Db;
  question: JudgeQuestionRow;
  studentImageRefs: string[];
  subjectId?: string;
  runTaskFn?: MultimodalDirectRunTaskFn;
  imageFetchFn?: MultimodalDirectImageFetchFn;
  ctx?: unknown;
}): Promise<StudentGradeVerdict> {
  const subjectProfile = params.subjectId
    ? resolveSubjectProfile(params.subjectId)
    : await resolveSubjectProfileForKnowledgeIds(params.db, params.question.knowledge_ids ?? []);
  const result = await runMultimodalDirectJudge({
    db: params.db,
    question: params.question,
    answer_md: '',
    student_image_refs: params.studentImageRefs,
    subjectProfile,
    runTaskFn: params.runTaskFn,
    imageFetchFn: params.imageFetchFn,
  });
  return {
    coarse_outcome: result.coarse_outcome,
    confidence: result.confidence,
  };
}

/**
 * YUK-482 cut ④ — production attribution_followup enqueue. The SAME job the human
 * import route fires (import.ts:506) so a graded FAILURE supersedes its placeholder
 * cause via the existing async attribution chain. Gated on
 * shouldEnqueueBackgroundJobs() (no boss in unit/test runtimes); best-effort —
 * a send failure is logged, never aborts the already-committed enroll.
 */
async function defaultEnqueueAttributionFollowup(attemptEventId: string): Promise<void> {
  const { shouldEnqueueBackgroundJobs } = await import('@/server/runtime-env');
  if (!shouldEnqueueBackgroundJobs()) return;
  try {
    const { getStartedBoss } = await import('@/server/boss/client');
    const boss = await getStartedBoss();
    await boss.send('attribution_followup', { attempt_event_id: attemptEventId });
  } catch (err) {
    console.warn(`[auto_enroll] attribution_followup enqueue failed for ${attemptEventId}:`, err);
  }
}
