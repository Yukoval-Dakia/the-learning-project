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
import { figuresForQuestion } from '@/capabilities/ingestion/server/figure_attach';
import { createKnowledgeNamer } from '@/capabilities/ingestion/server/knowledge-namer';
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
  AUTO_ENROLL_MAX_BLOCKS_PER_RUN,
  type FlagEnv,
  autoEnrollEnabled,
  autoEnrollThreshold,
  observeEnabled,
  studentAnswerGradingEnabled,
} from '@/capabilities/ingestion/server/workflow-judge-config';
import {
  type NameKcFn,
  isTagKnowledgeInvariantError,
  tagKnowledge,
} from '@/capabilities/knowledge/public';
import type { MistakeEnrollOutputT } from '@/core/schema/mistake_enroll';
import {
  type StructuredQuestionT,
  structuredToPromptMarkdown,
} from '@/core/schema/structured_question';
import type { TaggingOutputT } from '@/core/schema/tagging';
import type { Db } from '@/db/client';
import { knowledge, learning_session, question, question_block, source_asset } from '@/db/schema';
import type { WriteEventInput } from '@/kernel/events';
/**
 * WorkflowJudge auto-enroll path.
 *
 * Off by default: blocks stay draft for human review. When enabled, it tags and
 * judges at most AUTO_ENROLL_MAX_BLOCKS_PER_RUN draft blocks; 'auto' blocks are
 * enrolled through the same enrollCapturedBlock owner as the human path (only
 * provenance differs), and 'review' blocks stay untouched. It runs between
 * extraction and review and never closes the session.
 */
import { writeEvent } from '@/kernel/events';
import { withActiveCauseCategoryOverlays } from '@/kernel/read-models/cause-overlay';
import { resolveSubjectProfileForKnowledgeIds } from '@/kernel/read-models/subject-profile';
import { resolveSessionDerivationPolicy } from '@/kernel/read-models/usage-policy';
import { acquireLearningStateWriteLock } from '@/server/advisory-locks';
import { writeQuestionBlockLifecycleEvent } from '@/server/projections/question_block-lifecycle-event';
import { withAnswerClass } from '@/server/questions/answer-class-write';
import { publishQuestionGroupFromRow } from '@/server/questions/publisher';
import { getKnownSubjects } from '@/subjects/profile';
import { enrollNativeCapture } from './assessment-capture';
import { capturedQuestionShape } from './captured-question-shape';
import { redactIngestionText } from './privacy-guard';

export type AutoEnrollSkipReason = 'flag_off' | 'session_not_found' | 'wrong_status';

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
  /** Blocks left 'draft' for human review. */
  routed_to_review: number;
  /** Per-block detail for enrolled blocks. */
  blocks: AutoEnrolledBlock[];
}

export interface RunAutoEnrollParams {
  db: Db;
  sessionId: string;
  providerAttempt?: Parameters<typeof tagKnowledge>[0]['providerAttempt'];
  /** Restrict TaggingTask's candidate grid to one subject. */
  subjectId?: string;
  /** Test seam for observe-mode TaggingTask; enroll mode uses tagKnowledgeFn. */
  runTaggingFn?: (params: RunTaggingTaskParams) => Promise<TaggingOutputT>;
  /**
   * Enroll-path tagging. Defaults to `tagKnowledge` (embedding match-or-propose); a throw
   * routes the block to review.
   */
  tagKnowledgeFn?: typeof tagKnowledge;
  /** Test seam for observe-mode audit writes; a throw must affect only that block. */
  writeEventFn?: (db: Db, input: WriteEventInput) => Promise<string>;
  /** Test seam for observe-mode mistake metadata on answered blocks. */
  runMistakeEnrollFn?: (params: RunMistakeEnrollTaskParams) => Promise<MistakeEnrollOutputT>;
  /** Test seam for the per-session block-merge proposal pass. */
  runBlockAssemblyFn?: BlockAssemblyRunTaskFn;
  /** Naming seam passed to `tagKnowledge`; lets tests reuse a bridge result. */
  runColdStartBridgeFn?: ColdStartBridgeRunTaskFn;
  /** Override env for flag and threshold reads. */
  env?: FlagEnv;
  /** Shared wall-clock for the batch. */
  now?: Date;
  /** Forwarded to runTask ctx (subjectProfile). */
  ctx?: unknown;
}

/** Runs the gated auto-enroll path for one ingestion session. */
export async function runAutoEnrollForSession(
  params: RunAutoEnrollParams,
): Promise<RunAutoEnrollResult> {
  const env = params.env ?? process.env;

  // Enroll writes the imported question; observe only tags/judges for audit; the
  // default (both flags off) is a hard no-op.
  const mode: 'enroll' | 'observe' | 'off' = autoEnrollEnabled(env)
    ? 'enroll'
    : observeEnabled(env)
      ? 'observe'
      : 'off';
  if (mode === 'off') {
    return { status: 'skipped:flag_off', enrolled: 0, routed_to_review: 0, blocks: [] };
  }

  // Routing confidence does not grant native scoring admission.
  const threshold = autoEnrollThreshold(env);
  const now = params.now ?? new Date();
  const runTaggingFn = params.runTaggingFn ?? runTaggingTask;
  const tagKnowledgeFn = params.tagKnowledgeFn ?? tagKnowledge;
  const writeEventFn = params.writeEventFn ?? writeEvent;
  const runMistakeEnrollFn = params.runMistakeEnrollFn ?? runMistakeEnrollTask;
  // Student-answer grading is a separate opt-in and only writes durable data in
  // enroll mode.
  const studentGrading = mode === 'enroll' && studentAnswerGradingEnabled(env);

  // This session must be an ingestion session in an extractable state.
  const sessionRows = await params.db
    .select()
    .from(learning_session)
    .where(and(eq(learning_session.id, params.sessionId), eq(learning_session.type, 'ingestion')));
  const session = sessionRows[0];
  if (!session) {
    return { status: 'skipped:session_not_found', enrolled: 0, routed_to_review: 0, blocks: [] };
  }
  // Both modes accept 'partial' here, but enroll later narrows to 'extracted':
  // enroll flips blocks to imported, while the manual import guard rejects partial,
  // which would create a 409 mismatch. Observing a partial session is harmless.
  if (session.status !== 'extracted' && session.status !== 'partial') {
    return { status: 'skipped:wrong_status', enrolled: 0, routed_to_review: 0, blocks: [] };
  }

  // Resolve document usage once per run; every enrolled block inherits it instead of
  // paying an unindexed lookup per block.
  const sessionDocUsage = {
    policy: await resolveSessionDerivationPolicy(params.db, params.sessionId),
    sessionId: params.sessionId,
  };
  if (mode === 'enroll' && session.status !== 'extracted') {
    return { status: 'skipped:wrong_status', enrolled: 0, routed_to_review: 0, blocks: [] };
  }
  const sourceDocumentId = session.source_document_id ?? '';
  const sessionEntrypoint = session.entrypoint ?? 'vision_paper';

  // Bound the paid fan-out before assembly/tagging/judging/grading. Extraction enqueues
  // this job once per session; excess blocks stay draft for human review.
  const blocks = await params.db
    .select()
    .from(question_block)
    .where(
      and(
        eq(question_block.ingestion_session_id, params.sessionId),
        eq(question_block.status, 'draft'),
      ),
    )
    .orderBy(question_block.id)
    .limit(AUTO_ENROLL_MAX_BLOCKS_PER_RUN);

  // Block-assembly merge proposals run in both modes before any enroll import, while
  // blocks are still draft (mergeQuestions on user accept requires draft). AI only
  // proposes; an outage is logged and swallowed because it must not abort enrollment.
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
    // The structured tree is the canonical prompt source.
    const questionMd = block.structured
      ? structuredToPromptMarkdown(block.structured)
      : (block.extracted_prompt_md ?? '');
    if (questionMd.trim().length === 0) {
      routedToReview += 1;
      continue;
    }

    // This question's pages, falling back to all source assets without page_index. Used
    // for the judge, student images, and stored answer refs to limit inter-page bleed.
    const scopedPageRefs = pageScopedQuestionImageRefs(block);

    // Enroll uses tagKnowledge, which always attributes at least one KC, so tagging is no
    // longer a routing uncertainty. Synthesizing TaggingOutputT keeps the existing judge
    // unchanged. Observe keeps the read-only TaggingTask because tagKnowledge mutates KCs.
    let tagging: TaggingOutputT;
    if (mode === 'enroll') {
      try {
        // Resolve the PROPOSE parent. The production job passes no subjectId (subject is a
        // derived view), so classify it per block through the cold-start bridge, then reuse
        // that name for tagKnowledge so no second model call is made. Without this, a
        // missing subjectId would build `seed:undefined:root` and route every block to review.
        let subjectRootId: string;
        let bridgeNameKc: NameKcFn | undefined;
        if (params.subjectId) {
          subjectRootId = `seed:${params.subjectId}:root`;
        } else {
          const bridge = await runColdStartBridge({
            db: params.db,
            questionMd,
            // Placeholder forces the ECHO path; only the classified subject_id is used.
            existingReferenceMd: '(reference answer not needed for tagging)',
            knowledgeHint: block.knowledge_hint,
            knownSubjects: getKnownSubjects(),
            runTaskFn: params.runColdStartBridgeFn,
            ctx: params.ctx ?? { db: params.db },
          });
          subjectRootId = `seed:${bridge.subject_id}:root`;
          // Reuse the classified name so a PROPOSE makes no second model call.
          bridgeNameKc = async () => ({ kc_name: bridge.kc_name });
        }
        const tag = await tagKnowledgeFn(
          {
            db: params.db,
            providerAttempt: params.providerAttempt,
            nameKcFn:
              bridgeNameKc ??
              createKnowledgeNamer({
                db: params.db,
                runTaskFn: params.runColdStartBridgeFn,
                ctx: params.ctx ?? { db: params.db },
              }),
            batchCache: tagBatchCache,
          },
          {
            // Redact identifiers at the model boundary; redact the hint too so audit
            // events match the model-facing contract. sessionId binds the events to this
            // session for the live derivation policy.
            questionText: redactIngestionText(questionMd).text,
            knowledgeHint: block.knowledge_hint
              ? redactIngestionText(block.knowledge_hint).text
              : block.knowledge_hint,
            sessionId: params.sessionId,
            subjectRootId,
            sourceRef: { kind: 'question_block', id: block.id },
          },
        );
        tagging = synthesizeTaggingOutput(tag.knowledge_ids);
      } catch (err) {
        if (isTagKnowledgeInvariantError(err)) throw err;
        // Tagging failures must never auto-enroll, including plain errors from a missing
        // seed root. Swallow and log every non-invariant throw: aborting the batch would
        // retry forever, while human review is the backstop for anything not enrolled.
        console.error(
          `[auto_enroll] tagKnowledge failed for block ${block.id}; routing to review`,
          err,
        );
        routedToReview += 1;
        continue;
      }
    } else {
      // Observe uses the zero-mutation TaggingTask; an outage leaves the block draft.
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
      defaultQuestionKind: capturedQuestionShape(block.structured).kind,
      extractionConfidence: block.extraction_confidence,
      tagging,
      threshold,
    });

    const hasCapturedAnswer =
      Boolean(block.wrong_answer_md?.trim()) || (studentGrading && shouldGradeStudentWork(block));
    if (mode === 'enroll' && hasCapturedAnswer) {
      try {
        const result = await enrollNativeCapture(params.db, {
          block,
          knowledgeIds: verdict.prefilled.knowledge_ids,
          difficulty: verdict.prefilled.difficulty,
          confidence: verdict.confidence,
          canEnroll: verdict.route === 'auto',
          pageRefs: scopedPageRefs,
          docUsage: sessionDocUsage,
          now,
        });
        if (result) enrolled.push(result);
        else routedToReview += 1;
      } catch (error) {
        console.error(`[auto_enroll:capture] block ${block.id} requires review`, error);
        routedToReview += 1;
      }
      continue;
    }

    // For an answered block routed auto, draft the mistake metadata once and share it:
    // observe attaches it to the audit event, enroll uses its outcome. A draft failure
    // leaves it undefined; non-draft faults re-raise so the job retries.
    let mistakeDraft: MistakeEnrollOutputT | undefined;
    const studentAnswer = block.wrong_answer_md?.trim() ?? '';
    if (mode === 'observe' && verdict.route === 'auto' && studentAnswer.length > 0) {
      // The enroll vocabulary must include owner-accepted overlay categories, or clamping
      // would push them all back to 'other'.
      const profile = await withActiveCauseCategoryOverlays(
        params.db,
        await resolveSubjectProfileForKnowledgeIds(params.db, verdict.prefilled.knowledge_ids),
      );
      try {
        mistakeDraft = await runMistakeEnrollFn({
          questionMd,
          referenceMd: block.reference_md ?? null,
          studentAnswerMd: block.wrong_answer_md ?? null,
          knowledgeIds: verdict.prefilled.knowledge_ids,
          profile,
          db: params.db,
          ctx: { subjectProfile: profile },
        });
      } catch (err) {
        if (!(err instanceof MistakeEnrollTaskError)) throw err;
        console.error(`[auto_enroll] mistake_enroll draft failed for block ${block.id}`, err);
      }
    }

    // Observe writes one audit event per block for both routes, mutating no domain rows.
    // A failed audit write logs and continues so one bad write never aborts the batch.
    if (mode === 'observe') {
      try {
        await writeEventFn(params.db, {
          id: observeEventId(params.sessionId, block.id),
          // Bind to the session so the derivation filter applies the live document policy
          // on reads; the verdict embeds document-derived text in `reasoning`.
          session_id: params.sessionId,
          actor_kind: 'agent',
          actor_ref: 'workflow_judge',
          action: 'experimental:auto_enroll_observed',
          subject_kind: 'question_block',
          subject_id: block.id,
          outcome: verdict.route === 'auto' ? 'success' : 'skipped',
          payload: {
            mode: 'observe',
            generated_by: 'workflow_judge',
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
          // Opt out of memory ingestion: a non-null ingest_at makes the outbox poller
          // skip this row. This does not claim ingestion already ran.
          ingest_at: now,
          created_at: now,
        });
      } catch (err) {
        console.error(`[auto_enroll:observe] writeEvent failed for block ${block.id}`, err);
      }
      continue;
    }

    // tagKnowledge always attributes at least one KC, so a review route here means a
    // genuinely low-confidence extraction: leave it draft for human review.
    if (verdict.route !== 'auto') {
      routedToReview += 1;
      continue;
    }

    // Genuine unanswered material keeps the item-bank path.
    const outcome = 'unanswered' as const;
    const answerMd = '';
    const answerImageRefs: string[] = [];
    const captureMode = block.image_refs.length > 0 ? 'image' : 'text';
    const result = await params.db.transaction(async (tx) => {
      // Same tx-entry order as every learning-state writer and the cascade revert.
      await acquireLearningStateWriteLock(tx);
      // Concurrent consumers can both pass the draft SELECT above and insert duplicate
      // questions. Re-read this block FOR UPDATE and skip unless it is still draft; this
      // row lock is the structural double-consume guard. Singleton keys only reduce the
      // number of duplicate jobs and do not bear correctness.
      const claimRows = await tx
        .select({ status: question_block.status })
        .from(question_block)
        .where(eq(question_block.id, block.id))
        .for('update');
      if (claimRows[0]?.status !== 'draft') {
        return null; // already enrolled by a concurrent runner
      }

      // Attributed KCs are exactly what tagKnowledge returned pre-tx. Any KC it minted
      // is committed in its own tx, so a rollback here can orphan it; that is benign
      // (valid leaf under the subject root, reconciled by dedup-on-maintenance), and the
      // naming call must never sit inside this transaction.
      const enrollKnowledgeIds = verdict.prefilled.knowledge_ids;

      // A question is active only with a non-empty prompt, a valid kind, and at least one
      // live KC matching the attributed count. Structurally incomplete rows always land
      // draft; never force them active.
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
      const figureAssets = block.figures.length
        ? await tx
            .select({
              id: source_asset.id,
              storage_key: source_asset.storage_key,
              sha256: source_asset.sha256,
            })
            .from(source_asset)
            .where(
              inArray(
                source_asset.id,
                block.figures.map((figure) => figure.asset_id),
              ),
            )
        : [];
      await tx.insert(question).values(
        withAnswerClass({
          id: questionId,
          kind: verdict.prefilled.question_kind,
          choices_md: capturedQuestionShape(block.structured).choices_md,
          prompt_md: questionMd,
          // OCR-extracted answer only; reference generation is out of scope.
          reference_md: block.reference_md ?? null,
          knowledge_ids: enrollKnowledgeIds,
          difficulty: verdict.prefilled.difficulty,
          source: sessionEntrypoint,
          variant_depth: 0,
          figures: figuresForQuestion(block.structured, block.figures, {
            sourceAssetIds: block.source_asset_ids,
            assets: figureAssets,
          }),
          image_refs: block.image_refs,
          // Carry structured only when prompt_md is regenerable from it (ADR-0002);
          // questionMd is derived from structured, so they match when present.
          structured: block.structured ?? null,
          // Placement excludes only 'draft'; null and 'active' both pass.
          draft_status: draftStatus,
          metadata: {
            source_document_id: sourceDocumentId,
            ingestion_session_id: params.sessionId,
            question_block_id: block.id,
            // Judge decision for traceability; this path is reached only on auto.
            workflow_judge: {
              route: verdict.route,
              judge_route: verdict.route,
              confidence: verdict.confidence,
              reasoning: verdict.reasoning,
            },
          },
          created_at: now,
          updated_at: now,
          version: 0,
        }),
      );

      // Mint the first revision in the same transaction. Extraction and student answers
      // stay separate: a missing OCR answer is withheld, and student work goes through
      // the attempt event, never the answer key.
      await publishQuestionGroupFromRow(tx, {
        rootId: questionId,
        actorRef: 'auto-enroll:question',
        now,
      });

      // Same enrollment owner as the human path; only provenance and answer differ.
      const enroll = await enrollCapturedBlock(tx, {
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
      });

      const [{ version: blockVersion }] = await tx
        .update(question_block)
        .set({
          imported_question_id: questionId,
          imported_attempt_event_id: enroll.attemptEventId,
          // Distinct from human 'imported' so auto-enrollment stays revertible.
          status: 'auto_enrolled',
          updated_at: now,
          version: sql`${question_block.version} + 1`,
        })
        .where(eq(question_block.id, block.id))
        .returning({ version: question_block.version });

      // Fold-visible additive double-write in the same tx; carries everything
      // foldQuestionBlock needs to reproduce the row.
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
        knowledge_ids: enrollKnowledgeIds,
      } satisfies AutoEnrolledBlock;
    });

    // A concurrent runner already enrolled this block.
    if (result === null) continue;

    enrolled.push(result);

    // Failure-learning follows from the committed attempt event via the practice-owned
    // durable subscription, so this producer has no queue dependency.
  }

  return {
    status: 'completed',
    enrolled: enrolled.length,
    routed_to_review: routedToReview,
    blocks: enrolled,
  };
}

/**
 * Deterministic observe-event id: a stable sha256 so a job redelivery writes no
 * duplicate event and keeps the original `ingest_at`.
 */
export function observeEventId(sessionId: string, blockId: string): string {
  return createHash('sha256').update(`auto_enroll_observed:${sessionId}:${blockId}`).digest('hex');
}

/**
 * Adapts tagKnowledge ids to the TaggingOutputT the existing judge consumes. Attribution
 * is always structurally valid, so every suggestion is full-confidence.
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
 * Whether this extraction source reliably assessed handwriting, so a false
 * detectStudentWork is trustworthy. Only the VLM StructureTask and Tencent QuestionMark
 * do; glm_ocr never assesses and vision_rescue only opportunistically.
 */
export function extractionAssessedHandwriting(block: {
  structured: StructuredQuestionT | null;
}): boolean {
  const source = block.structured?.source;
  return source === 'vlm_structure' || source === 'tencent_ocr';
}

/**
 * Sources where handwriting is physically possible, so a degraded "no handwriting"
 * reading may be wrong. Text/manual sources have no whole-page handwriting to miss.
 */
const SCAN_SOURCES: ReadonlySet<string> = new Set([
  'glm_ocr',
  'vlm_structure',
  'tencent_ocr',
  'vision_rescue',
]);

/**
 * Grades when handwriting was detected, or when a scan source did not reliably assess it
 * (fail-open; StructureTask down must not skip grading). The fail-open stays scoped to
 * scan sources: elsewhere it would divert an auto-enrollable block into review, and text
 * sources have no handwriting to miss. An assessed scan with none skips to save cost.
 */
export function shouldGradeStudentWork(block: { structured: StructuredQuestionT | null }): boolean {
  if (detectStudentWork(block)) return true;
  const source = block.structured?.source;
  return source != null && SCAN_SOURCES.has(source) && !extractionAssessedHandwriting(block);
}

/**
 * Narrows the images fed to the student-answer judge to the pages this question spans,
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
