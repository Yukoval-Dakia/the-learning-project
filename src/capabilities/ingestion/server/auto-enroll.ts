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
import { resolveSubjectProfileForKnowledgeIds } from '@/capabilities/knowledge/server/subject-profile';
import { type NameKcFn, tagKnowledge } from '@/capabilities/knowledge/server/tag-knowledge';
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
import {
  isObjectiveJudgeRoute,
  recordFamilyObservationForAttempt,
} from '@/server/mastery/personalized-difficulty';
import { getMasteryState, updateThetaForAttempt } from '@/server/mastery/state';
import { writeQuestionBlockLifecycleEvent } from '@/server/projections/question_block-lifecycle-event';
import { withAnswerClass } from '@/server/questions/answer-class-write';
import { resolveSubjectProfile } from '@/subjects/profile';
import { KNOWN_SUBJECT_IDS } from '@/subjects/profile-schema';

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
  /**
   * Inject in tests; defaults to the production TaggingTask invoker. OBSERVE-mode only — the
   * ENROLL path runs the unified `tagKnowledge` (P3, YUK-489), not this grid-prefill TaggingTask.
   */
  runTaggingFn?: (params: RunTaggingTaskParams) => Promise<TaggingOutputT>;
  /**
   * P3 (YUK-489) — the unified ENROLL-path tagging step. Defaults to the production `tagKnowledge`
   * (embedding match-or-propose). DB tests inject a stub so the embedding/naming model is not
   * called (mirrors tag-knowledge.db.test.ts's embedFn/nameKcFn stubs at one level up): the stub
   * returns the attributed ids directly, and a throw routes the block to review (tagging outage).
   * Receives the same deps shape tagKnowledge does (db / runTaskFn / ctx / batchCache) plus the
   * input, so a real-default test can still seed embeddings + stub only the naming model.
   */
  tagKnowledgeFn?: typeof tagKnowledge;
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
   * P3 (YUK-489) — model seam for the unified `tagKnowledge` step's NAMING invoker. tagKnowledge's
   * default `nameKcFn` (makeDefaultNameKc → runColdStartBridge) names a PROPOSE child KC via one
   * LLM pass; this fn is threaded as tagKnowledge's `runTaskFn` so DB tests stub the model without
   * a real call. (The name is historical — the cold-start bridge module is now tagKnowledge's
   * naming engine, not a direct caller here.) Mirrors image-candidate-accept's `runColdStartBridgeFn`.
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

  // SHARED confidence threshold (default 0.85, env `AUTO_ENROLL_THRESHOLD`).
  // Two semantically distinct gates reuse this ONE number:
  //   (a) the TAGGING/routing judge — does this block auto-enroll vs route to human
  //       review (the historical use, gates the per-block `verdict` below);
  //   (b) the STUDENT-GRADE vision judge (cut ④) — is the vision verdict reliable
  //       enough to synthesize a graded attempt (gates `studentGradeVerdict`).
  // Deliberately shared for cut ④: introducing a separate `STUDENT_GRADE_THRESHOLD`
  // is deferred to YUK-485 (per-question narrowing), which is also where the
  // dense-page attribution concern lands. Flip ONE env to tune both today; revisit
  // if real rollout data shows the two judges need different bars.
  const threshold = autoEnrollThreshold(env);
  const now = params.now ?? new Date();
  const runTaggingFn = params.runTaggingFn ?? runTaggingTask;
  const tagKnowledgeFn = params.tagKnowledgeFn ?? tagKnowledge;
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

  // D5 (YUK-489) — ONE batch-coherence cache per ingestion-session run, shared across every
  // block's tagKnowledge call below. A single upload often has same-topic sibling questions; with
  // one shared cache the first sibling that PROPOSEs a KC name caches its id and every later
  // sibling proposing the same name reuses it (one KC, not N duplicates the P5 dedup lane would
  // otherwise reconcile). The loop awaits each block sequentially, satisfying the cache's
  // SEQUENTIAL-per-run contract. Used only on the enroll path (observe never tags via tagKnowledge).
  const tagBatchCache = new Map<string, string>();

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

    // YUK-488 — the page(s) THIS question spans (full source_asset_ids fallback when the
    // structured tree carries no page_index). Used as BOTH the judge's prompt image_refs and
    // the student image_refs below, AND the stored answer image_refs at enroll — so the judge
    // sees only this question's pages (not every sibling's), narrowing inter-page bleed.
    const scopedPageRefs = pageScopedQuestionImageRefs(block);

    // ---- YUK-482 cut ④ — student-answer grading (OUTSIDE the tx). ----
    // When the flag is ON and student work is plausible on the page (see the
    // YUK-487 fail-open gate below), grade the WHOLE PAGE IMAGE via the existing
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
    // YUK-487 — fail-OPEN the whole-page judge when extraction did not reliably assess
    // handwriting. detectStudentWork reads signals (student_answer_present /
    // extraction_evidence.handwriting) that ONLY the VLM StructureTask ('vlm_structure')
    // and Tencent ('tencent_ocr') set; on the 'glm_ocr' fallback (StructureTask down) or
    // an unknown/absent source a *false* result is uninformative, NOT a real "no student
    // work" — so grade anyway and let the judge be the detector (it returns
    // 'unsupported'/low-confidence → route-to-review below for blocks with no real
    // answer, so fail-open never synthesizes a bogus attempt). The reliable Opus judge
    // must not be blocked by a degraded extraction. Holistic per-page grading that drops
    // the extraction dependency entirely = YUK-488 (Fix B).
    if (studentGrading && shouldGradeStudentWork(block)) {
      // Build the judge row from the BLOCK's content (available pre-tx) — NOT a
      // persisted question row. image_refs = the whole-page images (YUK-488: scoped to
      // THIS question's pages, not all session pages), fed as the judge's prompt images.
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
        // YUK-488 — page-scoped (was block.image_refs = all session pages). Scoping ONLY
        // studentImageRefs below would be insufficient: the judge also fetches prompt
        // image_refs, so the page bleed would persist through this field. Both narrowed.
        image_refs: scopedPageRefs,
        structured: block.structured ?? null,
      };
      try {
        studentGradeVerdict = await gradeStudentAnswerFn({
          db: params.db,
          question: judgeQuestion,
          // YUK-488 — the student answer photo(s), page-scoped to THIS question's pages
          // (was block.source_asset_ids = every session page → inter-page bleed). cut ④
          // still grades the whole PAGE (no figure/bbox cropping) — just the right pages.
          studentImageRefs: scopedPageRefs,
          // Best pre-tx subject signal = the ingestion session's subject (the
          // grader resolves the SubjectProfile from it; the vision judge uses the
          // profile but does NOT gate on preferredRoutes — see GradeStudentAnswerFn).
          subjectId: params.subjectId,
          // runMultimodalDirectJudge seams (ignored when a stub gradeStudentAnswerFn
          // is injected; threaded so the REAL default grader is testable model-free).
          runTaskFn: params.gradeRunTaskFn,
          imageFetchFn: params.gradeImageFetchFn,
        });
      } catch (err) {
        // A grading outage must NEVER synthesize an attempt — route to review.
        console.error(`[auto_enroll:student_grade] judge failed for block ${block.id}`, err);
        routedToReview += 1;
        continue;
      }
      if (
        studentGradeVerdict.coarse_outcome === 'unsupported' ||
        // NOTE: shared threshold (see declaration above) — deliberately the SAME
        // bar as the tagging/routing judge for cut ④; split is YUK-485 follow-up.
        studentGradeVerdict.confidence < threshold
      ) {
        // YUK-485 gate: unconfident / ungradable → human review, block stays draft.
        routedToReview += 1;
        continue;
      }
    }

    // ---- Tagging (CONTENT/KC axis). ----------------------------------------------
    // P3 (YUK-489): the ENROLL path now runs the UNIFIED `tagKnowledge` (embedding
    // match-or-propose) instead of the old grid-prefill TaggingTask + cold-start-bridge.
    // `tagKnowledge` ALWAYS yields ≥1 knowledge_id (match an existing KC OR auto-approve a
    // freshly-PROPOSED child under the subject root, INSIDE its own tx, with an audit event) —
    // the dead `knowledge_ids:[]` zero-match window is gone (design §2/§3). We then SYNTHESIZE a
    // TaggingOutputT from the result so the EXISTING deterministic runWorkflowJudge stays
    // UNCHANGED: tagKnowledge attribution is structurally valid (matched existing OR
    // proposed-exactly-for-this), so tagging is no longer a routing-uncertainty source —
    // route='auto' fires on extraction confidence (always 1.0) ≥ threshold and hasSuggestions is
    // always true. The judge + mistakeDraft + observe paths keep reading
    // verdict.prefilled.knowledge_ids unchanged.
    //
    // OBSERVE mode keeps the old grid-prefill TaggingTask: tagKnowledge auto-approves a PROPOSE
    // KC (a mutation), which would violate observe's zero-domain-mutation contract (§5.4). Observe
    // is the audit-only quality probe — it must NOT create KCs — so it stays on runTaggingFn.
    let tagging: TaggingOutputT;
    if (mode === 'enroll') {
      try {
        // Resolve the PROPOSE parent + D1 subject root. params.subjectId is the cheap signal when
        // a caller supplies it (tests / any subject-pinned invocation). But the PRODUCTION job
        // (jobs/auto_enroll.ts) passes NO subjectId — subject is a derived view, never stored on
        // learning_session — so when it is absent we CLASSIFY the subject per-block via the
        // cold-start bridge (one LLM pass, mirroring image-candidate-accept), derive
        // seed:<subject>:root, and run tagKnowledge under it REUSING the bridge's name (no second
        // model call). Without this an absent subjectId would build `seed:undefined:root`, every
        // PROPOSE would throw in applyProposeNew→assertParentExists, and every thin-tree block
        // would silently route to review the moment the enroll flag is flipped on.
        let subjectRootId: string;
        let bridgeNameKc: NameKcFn | undefined;
        if (params.subjectId) {
          subjectRootId = `seed:${params.subjectId}:root`;
        } else {
          const bridge = await runColdStartBridge({
            db: params.db,
            questionMd,
            // Placeholder so the bridge takes its ECHO path — we discard its reference_md (P4a
            // owns reference generation) and use only the classified subject_id.
            existingReferenceMd: '(reference answer not needed for tagging)',
            knowledgeHint: block.knowledge_hint,
            knownSubjectIds: KNOWN_SUBJECT_IDS,
            runTaskFn: params.runColdStartBridgeFn,
            ctx: params.ctx ?? { db: params.db },
          });
          subjectRootId = `seed:${bridge.subject_id}:root`;
          // Reuse the bridge's already-classified name so a PROPOSE does NOT make a second model
          // call (mirrors image-candidate-accept).
          bridgeNameKc = async () => ({ kc_name: bridge.kc_name });
        }
        const tag = await tagKnowledgeFn(
          {
            db: params.db,
            // Thread the bridge runTask seam through tagKnowledge's default naming invoker
            // (makeDefaultNameKc → runColdStartBridge) so DB tests stub the model exactly as
            // before. `ctx` defaults to { db } when the caller omits one.
            runTaskFn: params.runColdStartBridgeFn,
            ctx: params.ctx ?? { db: params.db },
            // When the subject was bridge-classified (no subjectId), reuse the already-named KC.
            ...(bridgeNameKc ? { nameKcFn: bridgeNameKc } : {}),
            // D5 (YUK-489): ONE per-run cache shared across every block in this session, so
            // sibling questions proposing the same KC name reuse the first-minted id instead of
            // minting duplicates. The loop awaits each block sequentially (the cache's contract).
            batchCache: tagBatchCache,
          },
          {
            questionText: questionMd,
            knowledgeHint: block.knowledge_hint,
            subjectRootId,
          },
        );
        tagging = synthesizeTaggingOutput(tag.knowledge_ids);
      } catch (err) {
        // A tagging outage (provider down / unparseable name / missing seed root inside
        // applyProposeNew) must NEVER auto-enroll — route to review (block stays 'draft', upload
        // preserved). Mirrors the old TaggingTaskError swallow. We swallow ANY throw here (not
        // just a typed error) because tagKnowledge can throw a plain Error from applyProposeNew's
        // assertParentExists when the subject's seed root was never planted — that must
        // route-to-review, not abort the whole batch into a pg-boss retry-forever loop (the LOW
        // missing-seed-root guard the old inline cold-start path enforced).
        //
        // DELIBERATE best-effort contract: an UNEXPECTED fault (DB blip, programming bug) is ALSO
        // caught here — it is LOGGED via console.error (visible to monitoring) and the block is
        // routed to review rather than re-thrown. A best-effort enroll lane must never abort the
        // whole session batch, and the human review surface is the backstop for any block that did
        // not auto-enroll (nothing is lost). We trade pg-boss retry-on-transient for batch
        // resilience; a systemic fault surfaces as "everything routed to review" + the error log.
        console.error(
          `[auto_enroll] tagKnowledge failed for block ${block.id}; routing to review`,
          err,
        );
        routedToReview += 1;
        continue;
      }
    } else {
      // OBSERVE — the old grid-prefill TaggingTask (zero mutation). A tagging outage routes to
      // review (no observe event, block stays 'draft').
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

    // ---- Review gate. -----------------------------------------------------------------
    // P3 (YUK-489): the old cold-start-bridge gate is GONE — tagKnowledge subsumes it. The
    // thin-seed "zero KC match → invisible to placement" failure mode that the bridge worked
    // around can no longer occur: tagKnowledge ALWAYS attributes ≥1 KC (match OR a freshly
    // auto-approved PROPOSE child under the subject root, created in its own tx pre-enroll with
    // an audit event), so on the enroll path runWorkflowJudge always sees ≥1 suggestion +
    // extraction confidence 1.0 → route='auto'. A 'review' route here therefore means a genuine
    // low-confidence extraction — leave it 'draft' for human review (unchanged).
    if (verdict.route !== 'auto') {
      routedToReview += 1;
      continue;
    }

    // ---- MEDIUM-2 (independent review) — graded attempt MUST be mastery-attributable. ----
    // The student-grade gate and the tagging gate are independent, so a student-graded block
    // could in principle reach enroll with ZERO attributable KCs. If we enrolled it, the
    // `enrollKnowledgeIds.length>0` θ̂ guard below would silently skip mastery while the graded
    // attempt + 错因 are still written → an asymmetric attempt-without-mastery row. A graded
    // verdict that cannot be attributed to any KC belongs in HUMAN review (YUK-485). Kept as a
    // DEFENSIVE gate: with tagKnowledge always yielding ≥1 id (verdict.prefilled.knowledge_ids
    // is non-empty whenever route==='auto'), attributableKcCount is always ≥1 today, so this
    // never fires on the live enroll path — but it stays so a future tagging change that could
    // yield [] cannot synthesize a half-enrolled graded attempt. Only gates the graded path.
    const attributableKcCount = verdict.prefilled.knowledge_ids.length;
    if (studentGradeVerdict && attributableKcCount === 0) {
      routedToReview += 1;
      continue;
    }

    // ---- Auto-enroll this block (one tx, mirrors the human import route). ----
    // A2 (YUK-164): an ANSWERED block enrolls its REAL outcome from the draft
    // (failure/partial/success); an unanswered block (or a draft outage) stays
    // 'unanswered' (item-bank, no attempt) — the safest fallback (slice-3 behavior). A
    // PROPOSE-tagged enroll (a freshly-minted KC, no prior attempt) has no mistakeDraft when
    // unanswered, so it stays 'unanswered' = item-bank — matching the judge's outcome:'unanswered'
    // contract (workflow-judge.ts:79).
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

    // Explicit if/else (biome/OCR readability): graded verdict → the answer is the
    // page image (no text); unanswered → empty; otherwise the drafted wrong-answer md.
    let answerMd: string;
    if (gradedVerdict) {
      answerMd = '';
    } else if (outcome === 'unanswered') {
      answerMd = '';
    } else {
      answerMd = block.wrong_answer_md ?? '';
    }

    // YUK-488 — store the SAME page-scoped images the judge graded (was
    // block.source_asset_ids = all session pages). The stored answer photos must match
    // what produced the verdict — this question's pages, not every sibling's.
    const answerImageRefs = gradedVerdict ? scopedPageRefs : [];

    // Explicit if/else (biome/OCR readability): graded or figure-bearing → image
    // capture; otherwise text capture.
    let captureMode: 'text' | 'image';
    if (gradedVerdict) {
      captureMode = 'image';
    } else if (block.image_refs.length > 0) {
      captureMode = 'image';
    } else {
      captureMode = 'text';
    }
    const result = await params.db.transaction(async (tx) => {
      // ---- YUK-486 idempotency claim — guard concurrent double-consume. ----------------
      // Two pg-boss consumers (dev: rw:api's embedded RW_WORKER + standalone worker:dev; or a
      // prod retry re-delivered mid-flight) can both fetch an `auto_enroll` job for this session
      // and race: both pass the status='draft' SELECT above before either flips the block, then
      // both INSERT a question → duplicate enrollment (the YUK-486 symptom: 1 session/2 blocks →
      // 4 questions). Re-read THIS block FOR UPDATE inside the tx and bail if it is no longer
      // 'draft'. The row lock serializes the two runners on this block row: the first acquires it,
      // enrolls + flips status='auto_enrolled', commits → releases; the second then acquires it,
      // sees 'auto_enrolled', and skips (returns null). THIS claim is the STRUCTURAL guarantee
      // against double-INSERT — it holds for every producer and every run, including two jobs that
      // run truly concurrently. The singletonKey+singletonSeconds on the sends
      // (tencent_ocr_extract / docx-ingestion) is a best-effort layer that only REDUCES how many
      // duplicate jobs reach here; it does not bear correctness (and a bare singletonKey with no
      // seconds is inert on a standard-policy queue — see AUTO_ENROLL_SINGLETON_SECONDS). The
      // pre-tx tagKnowledge/grade LLM work the loser already did is wasted but harmless —
      // correctness, not cost, is the contract here. Precedent: revert-auto-enroll.ts.
      const claimRows = await tx
        .select({ status: question_block.status })
        .from(question_block)
        .where(eq(question_block.id, block.id))
        .for('update');
      if (claimRows[0]?.status !== 'draft') {
        return null; // already enrolled by a concurrent runner — skip (idempotent no-op)
      }

      // ---- KC attribution (P3, YUK-489). -----------------------------------------------
      // The attributed KCs are exactly what tagKnowledge returned pre-tx (matched existing KCs,
      // or a single auto-approved PROPOSE child it already created under the subject root in its
      // OWN tx + its own `experimental:auto_tag_kc_created` audit event). The old in-tx
      // applyProposeNew + `experimental:cold_start_kc_created` block is GONE — tagKnowledge owns
      // KC creation now (the cold-start bridge ① is subsumed).
      //
      // ATOMICITY (D2.7, accepted): tagKnowledge mints a PROPOSE KC in ITS OWN tx, BEFORE this
      // enroll tx opens. If this enroll tx rolls back, that auto-approved KC is already committed
      // (orphaned). This is BENIGN and matches image-candidate-accept's existing posture: the
      // orphan is a valid leaf under the subject root (live, approved, effective-domain-inherited),
      // harmless to placement, and reconciled by the P5 dedup-on-maintenance lane. We deliberately
      // do NOT fold tagKnowledge into this tx (its LLM naming call must never sit inside a DB tx —
      // design §3).
      const enrollKnowledgeIds = verdict.prefilled.knowledge_ids;

      // ---- Structural-verify gate (D2.6, ex-MEDIUM-1) — enforced for EVERY enroll. ----
      // A question is 'active' (placement-answerable) only when it has a non-empty prompt AND a
      // valid (truthy) kind AND ≥1 LIVE (non-archived) KC equal to the attributed-id count.
      // Previously this gated only cold-start enrolls; now it applies to ALL enrolled questions
      // (tagKnowledge always attributes a LIVE KC — matched or freshly auto-approved — so the
      // happy path is 'active' as before, but a structurally incomplete row, e.g. an id that
      // resolves to no live KC, can NEVER be silently forced active — it lands 'draft' for human
      // review). The invariant "active ⇔ ≥1 live KC" now holds for every enroll, never force-'active'.
      let draftStatus: 'active' | 'draft';
      {
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
        draftStatus = structurallyVerified ? 'active' : 'draft';
      }

      const questionId = createId();
      await tx.insert(question).values(
        withAnswerClass({
          id: questionId,
          kind: verdict.prefilled.question_kind,
          prompt_md: questionMd,
          // P3 (YUK-489) — reference_md is the OCR-extracted answer directly (block.reference_md),
          // or null. The cold-start bridge ③ reference GENERATION (when OCR got the prompt but no
          // answer, reference_md===null) is OUT of scope here — it is decoupled to P4a (the
          // `reference_md===null` trigger). We never synthesize a reference on this path.
          reference_md: block.reference_md ?? null,
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
          // draft_status from the structural-verify gate above ('active' when prompt + valid kind
          // + ≥1 live KC; else 'draft'). placement-select.ts excludes only draft_status='draft'
          // (NULL and 'active' both pass), so an 'active' row is immediately placement-answerable.
          // Set explicitly for EVERY enroll now (P3): tagKnowledge always attributes a live KC, so
          // the happy path is 'active'. The audit:draft-status gate passes an allowlisted-AND-
          // explicit file.
          draft_status: draftStatus,
          metadata: {
            source_document_id: sourceDocumentId,
            ingestion_session_id: params.sessionId,
            question_block_id: block.id,
            // OC-5: surface the judge decision on the question for traceability. With tagKnowledge
            // always attributing ≥1 KC, the enroll path is reached only when route==='auto', so
            // route + judge_route agree.
            workflow_judge: {
              route: verdict.route,
              judge_route: verdict.route,
              confidence: verdict.confidence,
              reasoning: verdict.reasoning,
              // YUK-482 cut ④ — traceability for a student-graded enroll: mark that
              // the whole page image was vision-graded + the graded confidence (the
              // YUK-485 gate above already enforced confidence >= threshold). Absent
              // (→ undefined) on the normal auto path so the metadata shape is unchanged.
              ...(gradedVerdict
                ? {
                    student_answer_graded: true,
                    student_grade_confidence: gradedVerdict.confidence,
                    student_grade_outcome: gradedVerdict.coarse_outcome,
                  }
                : {}),
            },
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
      // attributed enrollKnowledgeIds — the unified tagKnowledge verdict's ids, a MATCH to
      // existing KC(s) or a freshly auto-approved PROPOSE child). Mirrors paper-submit's call shape:
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
        // committed attempt survives.
        //
        // The hook early-returns unless judgeRoute ∈ OBJECTIVE_JUDGE_ROUTES
        // (exact/keyword). The student-graded path runs the `multimodal_direct`
        // vision judge — NOT an objective route — so the hook is GUARANTEED to be a
        // NO-OP today. Guard with `isObjectiveJudgeRoute('multimodal_direct')` so the
        // SAVEPOINT (and its DB round-trip) is skipped entirely when the route is
        // non-objective; the block re-enables automatically if `multimodal_direct`
        // is ever added to OBJECTIVE_JUDGE_ROUTES. partial is also early-returned
        // inside the hook (kept out of family calibration by design).
        if (isObjectiveJudgeRoute('multimodal_direct')) {
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

      const [{ version: blockVersion }] = await tx
        .update(question_block)
        .set({
          imported_question_id: questionId,
          imported_attempt_event_id: enroll.attemptEventId,
          // A2 (D1=C): a distinct terminal-but-revertible state, NOT human 'imported'.
          status: 'auto_enrolled',
          updated_at: now,
          version: sql`${question_block.version} + 1`,
        })
        .where(eq(question_block.id, block.id))
        .returning({ version: question_block.version });

      // YUK-471 W3-D — make the auto-enroll status/imports transition fold-visible (additive
      // double-write; same `now`/tx). op='set_status' carries status + imported_* + bumped version so
      // foldQuestionBlock reproduces this row. actor mirrors the chained judge event ('workflow_judge').
      await writeQuestionBlockLifecycleEvent(tx, {
        blockId: block.id,
        op: 'set_status',
        status: 'auto_enrolled',
        importedQuestionId: questionId,
        importedAttemptEventId: enroll.attemptEventId,
        nextVersion: blockVersion,
        actorKind: 'agent',
        actorRef: 'workflow_judge',
        now,
      });

      return {
        block_id: block.id,
        question_id: questionId,
        attempt_event_id: enroll.attemptEventId,
        record_id: enroll.recordId,
        confidence: verdict.confidence,
        // The actually-attributed set: the unified tagKnowledge verdict's ids (a MATCH to
        // existing KC(s) or a freshly auto-approved PROPOSE child), uniform for every enroll.
        knowledge_ids: enrollKnowledgeIds,
      } satisfies AutoEnrolledBlock;
    });

    // YUK-486 — the tx returned null because the idempotency claim found this block already
    // enrolled by a concurrent runner; skip without counting or enqueuing follow-up work.
    if (result === null) continue;

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
      // Best-effort: the default impl (`defaultEnqueueAttributionFollowup`) already
      // swallows internal errors, but an injected test seam (or a future impl) is
      // not contractually required to. Wrap so a throwing seam NEVER aborts the
      // already-committed enroll — matches the comment above and the import-route
      // precedent (import.ts logs + continues on boss.send failure).
      try {
        await enqueueAttributionFollowupFn(result.attempt_event_id);
      } catch (err) {
        console.warn(
          `[auto_enroll:student_grade] attribution_followup enqueue threw (non-fatal) for attempt ${result.attempt_event_id}:`,
          err,
        );
      }
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
 * P3 (YUK-489) — adapt a tagKnowledge result (a list of attributed knowledge ids) into the
 * TaggingOutputT shape the EXISTING deterministic runWorkflowJudge consumes, so the judge stays
 * UNCHANGED. tagKnowledge attribution is structurally valid (matched an existing KC OR proposed a
 * KC exactly for this question), so tagging is no longer a routing-uncertainty source: every
 * suggestion is full-confidence and overall_confidence is 1.0. With extraction confidence always
 * 1.0 and ≥1 suggestion, the weakest-link judge routes 'auto' on the enroll path.
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
 * YUK-487 — whether the extraction engine RELIABLY assessed handwriting (so a *false*
 * detectStudentWork from this block is a TRUSTWORTHY "no student work"). Only the VLM
 * StructureTask ('vlm_structure', sets student_answer_present) and Tencent QuestionMark
 * ('tencent_ocr', sets extraction_evidence.handwriting) do — the exact two signals
 * detectStudentWork reads. 'glm_ocr' (the VLM-down fallback) never assesses; 'vision_rescue'
 * sets handwriting evidence only OPPORTUNISTICALLY (from legacy wrong_answer_md), so its
 * absence is still uninformative.
 */
export function extractionAssessedHandwriting(block: {
  structured: StructuredQuestionT | null;
}): boolean {
  const source = block.structured?.source;
  return source === 'vlm_structure' || source === 'tencent_ocr';
}

/**
 * Scan/photo extraction sources — the ones where handwriting is physically possible, so a
 * degraded "no handwriting" reading is worth fail-opening on. Text/manual sources
 * ('docx_text' / 'manual' / 'agent_edit') and an absent/unknown source have no whole-page
 * handwriting to miss, so they are NEVER failed-open.
 */
const SCAN_SOURCES: ReadonlySet<string> = new Set([
  'glm_ocr',
  'vlm_structure',
  'tencent_ocr',
  'vision_rescue',
]);

/**
 * YUK-487 — gate for whole-page student-answer grading. Grade when EITHER detectStudentWork
 * flagged real handwriting, OR the block came from a SCAN/photo source whose handwriting was
 * NOT reliably assessed (fail-OPEN) — the YUK-487 failure: StructureTask down → 'glm_ocr' →
 * detectStudentWork false despite real handwriting → judge never ran.
 *
 * The fail-open is SCOPED to scan sources on purpose: the grading branch routes an
 * 'unsupported' verdict to review and `continue`s (skipping tagging/auto-enroll), so
 * fail-opening a non-scan block (e.g. a 'docx_text' question with evidence images) would
 * DIVERT a normally-auto-enrollable question into review. Text/manual sources have no
 * handwriting to miss, so they keep the normal path. Skip when a scan source assessed and
 * found none (cost guard). Holistic per-page grading that drops the extraction dependency
 * entirely = YUK-488.
 */
export function shouldGradeStudentWork(block: {
  structured: StructuredQuestionT | null;
}): boolean {
  if (detectStudentWork(block)) return true;
  const source = block.structured?.source;
  return source != null && SCAN_SOURCES.has(source) && !extractionAssessedHandwriting(block);
}

/**
 * YUK-488 — page-scope the images fed to the whole-page student-answer judge.
 *
 * Before this, cut ④ fed EVERY session page (block.source_asset_ids = all assets, and the
 * judge's prompt image_refs = block.image_refs = all assets too) to every block's judge
 * call — so the judge grading question A also saw questions B/C/D's pages. On a MULTI-PAGE
 * upload that is the inter-page attribution bleed YUK-485 flagged. This narrows the fed
 * images to the page(s) THIS question actually spans.
 *
 * Page set = every `page_index` in the question's structured subtree (top node + all
 * sub_questions). The VLM StructureTask populates page_index per node — incl. subs —
 * (nodeToStructured copies it recursively, YUK-227 P1; a cross-page 大题 carries DIFFERENT
 * page_index across its subs), and the Tencent multi-page fallback stamps it per page. Each
 * index maps to source_asset_ids[idx] (asset ids are stored in page order by
 * tencent_ocr_extract). Returns the matched assets in ascending page order, deduped.
 *
 * FALLBACK to the full source_asset_ids (today's behavior, ZERO regression) UNLESS EVERY node
 * in the subtree carries a valid integer page_index. So it falls back on: NO page_index at all
 * (legacy single-page tree / a fallback path that omits it), PARTIAL population (some nodes have
 * it, some don't — trusting a partial set could DROP a page the answer is on), a non-integer
 * value (NaN/float from a bad edit), OR any derived index out of range. Deliberately
 * conservative: an incomplete/unreliable page signal must never narrow — better to over-feed
 * (today's bleed) than to silently starve the judge of the answer page.
 *
 * KNOWN LIMIT (accepted — narrow scope, owner-directed): scoping to the structured (prompt)
 * pages can drop a SEPARATE answer-sheet page (机读卡 / a continuation not in the prompt's
 * span). For the cold-start worked-paper upload (handwriting inline ON the question page)
 * the answer shares the prompt's page → kept. The separate-answer-sheet case degrades to the
 * judge seeing no answer → unsupported/low-confidence → the EXISTING needs-review gate routes
 * it to a human (never a silent wrong grade). SAME-PAGE dense attribution (the YUK-485
 * headline) is NOT addressed by page-scoping — it is a no-op when every question is on one
 * page; that needs whole-page holistic reasoning, deferred out of this cut.
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
    // Number.isInteger (not `typeof === 'number'`): the schema types page_index as int≥0, but
    // structured is jsonb and an agent-edit / malformed VLM output could carry NaN or a float.
    // typeof would admit those; then NaN slips the out-of-range guard below (NaN<0 and
    // NaN>=len are both false) → all[NaN] = undefined fed to R2/judge. Integer-only entry keeps
    // such a node OUT of the trusted set (and, via the complete-signal gate below, forces the
    // feed-all fallback). (augment review #573 + independent reviewer #7.)
    const pi = node.page_index;
    if (typeof pi === 'number' && Number.isInteger(pi)) {
      pages.add(pi);
      nodesWithPage += 1;
    }
    if (node.sub_questions) {
      for (const sub of node.sub_questions) stack.push(sub);
    }
  }
  // COMPLETE-signal gate (concern #2 — both reviewers): scope ONLY when EVERY node in the subtree
  // carries a valid integer page_index. PARTIAL population (some nodes have it, some don't) is NOT
  // trusted: a sub on a page whose node omitted page_index would be DROPPED, starving the judge of
  // the answer page (the VLM does not guarantee per-node page_index — figure_attach.ts:27 documents
  // the same partial-population reality). Partial OR zero signal → feed all (today's behavior, ZERO
  // regression — the conservative direction: never drop a page the answer might be on). The
  // dominant win is preserved: a standalone question wholly on one page has its single node carry
  // page_index → complete → scoped; a cross-page 大题 narrows only when the VLM stamped EVERY node.
  if (pages.size === 0 || nodesWithPage < totalNodes) return all;
  const sorted = [...pages].sort((a, b) => a - b);
  // Belt-and-suspenders: any out-of-range index ⇒ the page map is untrustworthy → feed all.
  if (sorted.some((p) => p < 0 || p >= all.length)) return all;
  return sorted.map((p) => all[p]);
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
