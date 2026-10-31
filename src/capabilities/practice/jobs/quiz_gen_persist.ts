// QuizGen draft persistence.
//
// One transaction writes the fetched material, draft questions, composite parts,
// the first publication, verify intents, and the tool_quiz artifact. Paid
// generation stays outside this transaction: a persist failure rolls the drafts
// back and leaves the provider call already recorded on the attempt.

import { randomUUID } from 'node:crypto';
import { createId } from '@paralleldrive/cuid2';
import { and, eq, sql } from 'drizzle-orm';
import { aiAgentRef } from '@/ai/task-result';
import {
  DifficultyEvidence,
  type DifficultyEvidenceT,
  buildProducerDifficultyEvidence,
} from '@/core/schema/difficulty-evidence';
import { defaultJudgeKindForQuestion } from '@/core/schema/judge-routing';
import type { QuizGenMetadataT } from '@/core/schema/quiz_gen';
import type { Tx } from '@/db/client';
import {
  artifact,
  placement_starter_attempt_question,
  question,
  source_document,
} from '@/db/schema';
import { artifactRowToCreateSnapshot, emitArtifactCreateEvent } from '@/kernel/artifacts';
import { withAnswerClass } from '@/kernel/records/answer-class-write';
import { publishQuestionGroupFromRow } from '@/kernel/records/assessment-publication';
import { materializeGeneratedQuestionParts } from '../server/question-parts';
import {
  type SupplyTraceV1T,
  withSupplyTraceDifficultyEvidence,
} from '../server/question-supply/evidence-demand';
import {
  type PlacementAttemptAuthority,
  type PlacementVerificationAuthority,
  assertPlacementAttemptFence,
} from '../server/question-supply/placement-starter-attempts';
import {
  type ExactQuestionDuplicateKnowledgeMerge,
  canonicalQuestionContentHash,
  combineExactDuplicateKnowledgeIds,
  mergeExactQuestionDuplicateKnowledgeIds,
} from '../server/quiz/content-fingerprint';
import {
  embedMaterialInPrompt,
  synthesizeMaterialSourceRefs,
} from '../server/quiz/quiz-gen-material';
import { writeVerifyDispatchIntent } from '../server/verify-dispatch-outbox';
import type {
  GeneratedQuizDrafts,
  QuizGenerationContext,
  QuizGenerationEvidence,
  RunQuizGenParams,
} from './quiz_gen';

async function authorizeAndDispatchPlacementQuestion(
  tx: Tx,
  input: {
    attempt: PlacementAttemptAuthority | undefined;
    questionId: string;
    canonicalHash: string;
    supplyTrace: SupplyTraceV1T | undefined;
    allowPersistedReplay: boolean;
    now: Date;
  },
): Promise<boolean> {
  const { attempt, questionId, canonicalHash, supplyTrace, allowPersistedReplay, now } = input;
  if (!attempt) return false;
  const inserted = await tx
    .insert(placement_starter_attempt_question)
    .values({
      attempt_id: attempt.attemptId,
      claim_id: attempt.claimId,
      question_id: questionId,
      canonical_hash: canonicalHash,
      verification_authority_epoch: randomUUID(),
      verification_status: 'authorized',
      created_at: now,
    })
    .onConflictDoNothing()
    .returning({
      claimId: placement_starter_attempt_question.claim_id,
      attemptId: placement_starter_attempt_question.attempt_id,
      questionId: placement_starter_attempt_question.question_id,
      epoch: placement_starter_attempt_question.verification_authority_epoch,
    });
  let persisted = inserted[0];
  if (inserted.length > 1) {
    throw new Error('placement authority insert returned multiple rows');
  }
  if (!persisted && allowPersistedReplay) {
    [persisted] = await tx
      .select({
        claimId: placement_starter_attempt_question.claim_id,
        attemptId: placement_starter_attempt_question.attempt_id,
        questionId: placement_starter_attempt_question.question_id,
        epoch: placement_starter_attempt_question.verification_authority_epoch,
      })
      .from(placement_starter_attempt_question)
      .where(
        and(
          eq(placement_starter_attempt_question.attempt_id, attempt.attemptId),
          eq(placement_starter_attempt_question.question_id, questionId),
        ),
      )
      .limit(1);
  }
  if (!persisted) return false;
  const authority: PlacementVerificationAuthority = {
    claim_id: persisted.claimId,
    attempt_id: persisted.attemptId,
    question_id: persisted.questionId,
    verification_authority_epoch: persisted.epoch,
    fencing_token: attempt.fencingToken,
  };
  await writeVerifyDispatchIntent(tx, {
    questionId: persisted.questionId,
    verifier: 'quiz_verify',
    supplyTrace,
    placementAuthority: authority,
    createdAt: now,
  });
  return true;
}

async function reconcileRacedDuplicate(
  tx: Tx,
  input: {
    id: string;
    canonicalContentHash: string;
    duplicateKnowledgeIds: string[];
    taskRunId: string | undefined;
    now: Date;
  },
): Promise<
  { kind: 'retry_insert' } | { kind: 'merged'; duplicate: ExactQuestionDuplicateKnowledgeMerge }
> {
  const { id, canonicalContentHash, duplicateKnowledgeIds, taskRunId, now } = input;
  const racedDuplicate = await mergeExactQuestionDuplicateKnowledgeIds(tx, {
    canonicalContentHash,
    knowledgeIds: duplicateKnowledgeIds,
    actorRef: 'quiz_gen',
    taskRunId,
    now,
  });
  if (!racedDuplicate) {
    throw new Error(`quiz_gen canonical hash conflict did not resolve for ${id}`);
  }
  if (racedDuplicate.disposition !== 'released_terminal_draft') {
    return { kind: 'merged', duplicate: racedDuplicate };
  }
  return { kind: 'retry_insert' };
}

export async function persistQuizDrafts(
  params: RunQuizGenParams,
  context: QuizGenerationContext,
  generated: GeneratedQuizDrafts,
  evidence: QuizGenerationEvidence,
) {
  const { db, trigger, resolved, toolContextTaskRunId } = context;
  const {
    result,
    parsed,
    parseRepaired,
    normalizedComposites,
    resolveQuestionKnowledgeIds,
    targetKnowledgeIds,
  } = generated;
  const questionIds: string[] = [];
  // YUK-1011 — observability counter for the run event: total question_part
  // rows materialized under the composite parents this run inserted.
  let compositePartCount = 0;
  // Placement-authorized questions whose verify intent must be drained THIS attempt but which are
  // NOT in questionIds — currently exact duplicates of an existing draft (they get an authority +
  // verify intent but reuse the existing row, so they never enter questionIds). Without draining
  // them here their intent waits for daily recovery while reconcilePlacementDelivery blocks to the
  // deadline (codex P2, YUK-452 review).
  const placementDrainOnlyIds: string[] = [];
  const difficultyEvidenceByQuestion: Array<{
    question_id: string;
    evidence: DifficultyEvidenceT;
  }> = [];
  const exactDuplicates: Array<{
    existing_question_id: string;
    new_question_id: string;
    canonical_content_hash: string;
    source_route: 'quiz_gen';
    knowledge_merge_status: 'merged' | 'already_covered';
    added_knowledge_ids: string[];
    resulting_knowledge_ids: string[];
    preserved_draft_status: string | null;
  }> = [];
  const quizKnowledgeIds = new Set<string>();
  const syncOwnedDuplicateKnowledge = (duplicate: { id: string; knowledgeIds: string[] }) => {
    // A duplicate can be a pre-existing/global question (not part of this artifact) or a question
    // freshly inserted earlier in this same batch. Only the latter belongs to tool_state, so keep
    // the artifact tags aligned when a later generated item expands that owned row's attribution.
    if (!questionIds.includes(duplicate.id)) return;
    for (const knowledgeId of duplicate.knowledgeIds) quizKnowledgeIds.add(knowledgeId);
  };
  const toolQuizArtifactId = createId();
  const now = new Date();
  // YUK-224 (slice 3, tier 3) — material_grounded persists the fetched REAL source
  // material to a source_document row FIRST (with the URL in provenance), then every
  // generated question carries that row id in metadata.quiz_gen.material_source_document_id.
  // The output schema guarantees `parsed.material` is present when the method is
  // material_grounded (superRefine). source_document has no step9 invariant audit
  // (only event / learning_session / material_fsrs_state / artifact are audited), so
  // this new writer needs no allowlist registration. The id is shared across all
  // questions in the run (one passage → many questions probing it).
  let materialSourceDocumentId: string | null = null;
  evidence.failureStage = 'persist';
  await params.placementHeartbeat?.assertHealthy();
  await db.transaction(async (tx) => {
    if (params.placementAttempt) {
      await assertPlacementAttemptFence(tx, params.placementAttempt);
    }
    if (parsed.generation_method === 'material_grounded' && parsed.material) {
      materialSourceDocumentId = createId();
      await tx.insert(source_document).values({
        id: materialSourceDocumentId,
        title: parsed.material.title,
        source_asset_ids: [],
        body_md: parsed.material.body_md,
        // URL provenance — the fetched material's origin. source_kind tags it as a
        // quiz_gen-fetched material so audits can distinguish it from ingestion docs.
        provenance: {
          source_kind: 'quiz_gen_material',
          url: parsed.material.url,
          fetched_at: parsed.material.fetched_at,
          captured_by: aiAgentRef('QuizGenTask', result),
        } as never,
        created_at: now,
        updated_at: now,
        version: 0,
      });
    }
    const authorizePlacementQuestion = (
      questionId: string,
      canonicalHash: string,
      supplyTrace: SupplyTraceV1T | undefined,
      allowPersistedReplay: boolean,
    ) =>
      authorizeAndDispatchPlacementQuestion(tx, {
        attempt: params.placementAttempt,
        questionId,
        canonicalHash,
        supplyTrace,
        allowPersistedReplay,
        now,
      });
    for (const [index, q] of parsed.questions.entries()) {
      const id = createId();
      // YUK-1011 — composite item's normalized stem+subs tree (gated +
      // normalized pre-tx above); null for flat questions.
      const composite = normalizedComposites[index] ?? null;
      // Composite parents are whole-group graded: forced 'semantic' (the
      // merged multi-sub reference can never exact-match) — asserted on this
      // persisted shape in parseOutput. Flat questions keep the derived route.
      const judgeKind = composite ? 'semantic' : defaultJudgeKindForQuestion(q);
      const questionKnowledgeIds = resolveQuestionKnowledgeIds(q);
      const declaredDifficultyEvidence =
        q.difficulty_evidence ?? buildProducerDifficultyEvidence(q.difficulty, 'quiz_gen', now);
      const difficultyEvidence = DifficultyEvidence.parse({
        ...declaredDifficultyEvidence,
        observed_at: declaredDifficultyEvidence.observed_at ?? now.toISOString(),
        source_route: declaredDifficultyEvidence.source_route ?? 'quiz_gen',
      });
      const questionSupplyTrace = params.supplyTrace
        ? withSupplyTraceDifficultyEvidence(params.supplyTrace, difficultyEvidence)
        : undefined;
      // YUK-224 F3 — material_grounded: synthesize a per-question source_ref from
      // the top-level material (url + passage snippet) so the deterministic
      // copy-safety overlap has the passage to compare against. Non-material runs
      // keep the agent-declared refs verbatim.
      const effectiveSourceRefs =
        parsed.generation_method === 'material_grounded' && parsed.material
          ? synthesizeMaterialSourceRefs(q.source_refs, parsed.material)
          : q.source_refs;

      // YUK-224 F1 — material_grounded: embed the passage into prompt_md so the
      // review / practice render (which only reads prompt_md) shows the learner
      // the material the题干 references. Non-material runs keep the prompt verbatim.
      // YUK-1011 — a composite item persists the DERIVED render instead: prompt_md /
      // reference_md come from the normalized stem+subs tree (single source of truth —
      // the material embed already happened inside the stem's prompt_text for
      // material_grounded composites), and choices_md stays NULL (per-sub options live
      // in the tree, not the flat column).
      const effectivePromptMd = composite
        ? composite.prompt_md
        : parsed.generation_method === 'material_grounded' && parsed.material
          ? embedMaterialInPrompt(q.prompt_md, parsed.material.body_md)
          : q.prompt_md;
      const effectiveReferenceMd = composite ? composite.reference_md : q.reference_md;
      const effectiveChoicesMd = composite ? null : (q.choices_md ?? null);
      const canonicalContentHash = canonicalQuestionContentHash({
        promptMd: effectivePromptMd,
        referenceMd: effectiveReferenceMd,
        choicesMd: effectiveChoicesMd,
        rubricJson: q.rubric_json,
        // YUK-1011 — shape discriminator: a composite parent's derived render
        // can be byte-identical to a flat question's text; without this the
        // merge branch would adopt the childless flat row and silently skip
        // part materialization (poolFetch(compositeParentOnly) would still
        // reject it). Flat items omit the key → byte-identical legacy hash.
        composite: composite != null,
      });
      const duplicateKnowledgeIds = combineExactDuplicateKnowledgeIds(
        questionKnowledgeIds,
        targetKnowledgeIds,
      );
      const existingDuplicate = await mergeExactQuestionDuplicateKnowledgeIds(tx, {
        canonicalContentHash,
        knowledgeIds: duplicateKnowledgeIds,
        actorRef: 'quiz_gen',
        taskRunId: result.task_run_id,
        now,
      });
      if (existingDuplicate?.disposition === 'merged') {
        syncOwnedDuplicateKnowledge(existingDuplicate);
        exactDuplicates.push({
          existing_question_id: existingDuplicate.id,
          new_question_id: id,
          canonical_content_hash: canonicalContentHash,
          source_route: 'quiz_gen',
          knowledge_merge_status:
            existingDuplicate.addedKnowledgeIds.length > 0 ? 'merged' : 'already_covered',
          added_knowledge_ids: existingDuplicate.addedKnowledgeIds,
          resulting_knowledge_ids: existingDuplicate.knowledgeIds,
          preserved_draft_status: existingDuplicate.draftStatus,
        });
        if (params.placementAttempt) {
          const dupAuthorized = await authorizePlacementQuestion(
            existingDuplicate.id,
            canonicalContentHash,
            params.supplyTrace,
            true,
          );
          // Drain the duplicate's intent this attempt (it never enters questionIds).
          if (dupAuthorized) placementDrainOnlyIds.push(existingDuplicate.id);
        }
        continue;
      }
      await params.afterExactDuplicateLookupMiss?.();

      // §2 — metadata.quiz_gen: the agent self-reports source_pack + per-run
      // copy_safety; we fold the per-question source_refs into the row's
      // metadata so each draft carries its own provenance.
      const metaQuizGen: QuizGenMetadataT = {
        source_pack: parsed.source_pack,
        source_refs: effectiveSourceRefs,
        generation_method: parsed.generation_method,
        // V1 LOW — the agent self-reports verdict + max_overlap, but the gen
        // stage MUST stamp checked_by='agent_self' itself; an agent claiming
        // checked_by='quiz_verify' here would forge a verification it never ran.
        // QuizVerify (Q5) overwrites this whole block with checked_by='quiz_verify'
        // once it actually runs.
        copy_safety: {
          verdict: parsed.self_copy_safety.verdict,
          ...(parsed.self_copy_safety.max_overlap !== undefined
            ? { max_overlap: parsed.self_copy_safety.max_overlap }
            : {}),
          checked_by: 'agent_self',
        },
        generation_status: 'ready',
        // YUK-224 tier 3 — back-fill the persisted material's source_document id so
        // deriveSourceTier lands tier 3 (material_grounded + material_source_document_id).
        // Only set for material_grounded; the QuizGenMetadata superRefine requires it
        // when generation_method='material_grounded', so this is the live writer that
        // naturally satisfies that contract.
        ...(materialSourceDocumentId
          ? { material_source_document_id: materialSourceDocumentId }
          : {}),
        // YUK-607 review round — jsonrepair 级修复的批整批标记；quiz_verify 据此封顶
        // needs_review（内容完整性留 owner /drafts 人审）。
        ...(parseRepaired ? { parse_repaired: true } : {}),
      };
      const questionRow = withAnswerClass({
        id,
        kind: q.kind,
        source: 'quiz_gen',
        prompt_md: effectivePromptMd,
        reference_md: effectiveReferenceMd,
        rubric_json: q.rubric_json ?? null,
        choices_md: effectiveChoicesMd,
        judge_kind_override: judgeKind,
        // YUK-1011 — composite parents carry the normalized stem+subs tree on
        // the structured column (same column OCR/author_question use); flat
        // questions keep NULL.
        structured: composite?.structured ?? null,
        // The target KC union is the supply contract: a fresh INSERT and a duplicate MERGE
        // must attribute identical content the same way, including the trigger's live KCs.
        knowledge_ids: duplicateKnowledgeIds,
        difficulty: q.difficulty,
        // §2 — trigger pointer (knowledge_id / learning_item_id), NOT a web URL.
        source_ref: resolved.refId,
        created_by: aiAgentRef('QuizGenTask', result),
        metadata: {
          quiz_gen: metaQuizGen,
          difficulty_evidence: difficultyEvidence,
          ...(questionSupplyTrace ? { supply_trace: questionSupplyTrace } : {}),
        },
        created_at: now,
        canonical_content_hash: canonicalContentHash,
        updated_at: now,
      });
      const inserted = await tx
        .insert(question)
        // Option B (§3) — generated drafts do NOT enter the pool / FSRS until
        // quiz_verify passes (Q5 promotes draft→active + enrolls). Keep this field
        // explicit at every INSERT site so audit:draft-status can prove the gate.
        .values({ ...questionRow, draft_status: 'draft' })
        // Scope the arbiter to the canonical-hash partial unique index (WHERE
        // canonical_content_hash IS NOT NULL). A bare ON CONFLICT DO NOTHING would
        // silently swallow ANY unique conflict (e.g. the PK), making the
        // `inserted.length === 0` fallback below misread an unrelated conflict as a
        // hash collision. The `where` predicate is REQUIRED for Postgres to infer a
        // partial unique index as the arbiter.
        .onConflictDoNothing({
          target: question.canonical_content_hash,
          where: sql`${question.canonical_content_hash} is not null`,
        })
        .returning({ id: question.id });
      const raced =
        inserted.length === 0
          ? await reconcileRacedDuplicate(tx, {
              id,
              canonicalContentHash,
              duplicateKnowledgeIds,
              taskRunId: result.task_run_id,
              now,
            })
          : undefined;
      if (raced?.kind === 'retry_insert') {
        // Keep the content write in the same publisher-owned scope as the initial INSERT.
        const retried = await tx
          .insert(question)
          .values({ ...questionRow, draft_status: 'draft' })
          .onConflictDoNothing({
            target: question.canonical_content_hash,
            where: sql`${question.canonical_content_hash} is not null`,
          })
          .returning({ id: question.id });
        if (retried.length === 0) {
          throw new Error(`quiz_gen canonical hash retry still conflicted for ${id}`);
        }
      }
      if (raced?.kind === 'merged') {
        const racedDuplicate = raced.duplicate;
        syncOwnedDuplicateKnowledge(racedDuplicate);
        exactDuplicates.push({
          existing_question_id: racedDuplicate.id,
          new_question_id: id,
          canonical_content_hash: canonicalContentHash,
          source_route: 'quiz_gen',
          knowledge_merge_status:
            racedDuplicate.addedKnowledgeIds.length > 0 ? 'merged' : 'already_covered',
          added_knowledge_ids: racedDuplicate.addedKnowledgeIds,
          resulting_knowledge_ids: racedDuplicate.knowledgeIds,
          preserved_draft_status: racedDuplicate.draftStatus,
        });
        if (params.placementAttempt) {
          const racedAuthorized = await authorizePlacementQuestion(
            racedDuplicate.id,
            canonicalContentHash,
            questionSupplyTrace,
            true,
          );
          // Drain the raced duplicate's intent THIS attempt (it never enters questionIds), same
          // as the pre-check duplicate branch. Load-bearing for a DRAFT raced duplicate: without
          // it the intent waits for daily recovery and reconcile strands to the deadline. An
          // ACTIVE raced duplicate settles via pool-visibility regardless (YUK-452 followup).
          if (racedAuthorized) placementDrainOnlyIds.push(racedDuplicate.id);
        }
        continue;
      }
      // YUK-1011 — composite persist: the fresh parent's normalized sub nodes
      // become question_part child rows in the SAME transaction (the group is
      // atomic — a part can never outlive a parent insert rollback). Each child
      // carries the narrowed stem+single-sub tree (stem prompt_text keeps the
      // passage, so the part's prompt_md is self-contained), an ordered
      // part_index, and draft_status='draft': parts never get their own verify
      // intent — the parent's quiz_verify promotion cascades to them (see
      // quiz_verify.ts). Skipped on every duplicate/merge `continue` above —
      // an existing row keeps its existing parts.
      if (composite) {
        const createdPartCount = await materializeGeneratedQuestionParts(tx, {
          parentQuestionId: id,
          structured: composite.structured,
          knowledgeIds: duplicateKnowledgeIds,
          difficulty: q.difficulty,
          quizGenMetadata: metaQuizGen,
          difficultyEvidence,
          supplyTrace: questionSupplyTrace,
          now,
        });
        compositePartCount += createdPartCount;
      }
      // YUK-1043（复审裁决：可行写口即刻收敛）—— quiz_gen 新题同事务铸首版
      // revision：composite 组已由 createQuestionPart 的逐 part 发布落版（此处
      // 幂等 noop）；单题在此铸 v1。草稿未核验 ⇒ withheld/unverified_rules
      //（quiz_verify 通过后 promote 翻 admitted —— 行 6 已接）。
      await publishQuestionGroupFromRow(tx, {
        rootId: id,
        actorRef: 'quiz_gen:persist',
        now,
      });
      if (params.placementAttempt) {
        const authorized = await authorizePlacementQuestion(
          id,
          canonicalContentHash,
          questionSupplyTrace,
          false,
        );
        if (!authorized) continue;
      } else {
        await writeVerifyDispatchIntent(tx, {
          questionId: id,
          verifier: 'quiz_verify',
          supplyTrace: questionSupplyTrace,
          createdAt: now,
        });
      }
      // Aggregate exactly the persisted question attribution (model-valid ids + supply target),
      // not the narrower pre-union model ids. Add only after a fresh row actually landed so the
      // artifact's tags describe its own tool_state.question_ids, not skipped duplicates.
      for (const kid of duplicateKnowledgeIds) quizKnowledgeIds.add(kid);
      questionIds.push(id);
      difficultyEvidenceByQuestion.push({ question_id: id, evidence: difficultyEvidence });
    }

    // When every generated question resolved to an exact duplicate there is
    // nothing new to serve — creating a generation_status='ready' tool_quiz with
    // tool_state.question_ids: [] would surface a practicable ZERO-question paper.
    // Skip the artifact; the post-tx event still records the duplicate outcome.
    if (questionIds.length === 0) return;

    // YUK-471 W3-C1β — INSERT … RETURNING + same-tx artifact_create from the materialized row.
    // No causing event row exists at this point (the experimental:quiz_gen event is written AFTER
    // the tx), so the create event is unchained; created_at == the row's `now`.
    const [insertedArtifact] = await tx
      .insert(artifact)
      .values({
        id: toolQuizArtifactId,
        type: 'tool_quiz',
        title: resolved.title ? `${resolved.title} 组卷` : '自定义组卷',
        parent_artifact_id: null,
        knowledge_ids: [...quizKnowledgeIds],
        intent_source: 'quiz_gen',
        source: 'ai_generated',
        source_ref: resolved.refId,
        body_blocks: null,
        attrs: {
          trigger,
          generation_method: parsed.generation_method,
          source_pack: parsed.source_pack,
        } as never,
        tool_kind: 'quiz_gen',
        tool_state: {
          question_ids: questionIds,
          session_meta: {
            trigger,
            ref_id: resolved.refId,
            generation_method: parsed.generation_method,
            tool_context_task_run_id: toolContextTaskRunId,
          },
        } as never,
        generation_status: 'ready',
        verification_status: 'not_required',
        generated_by: aiAgentRef('QuizGenTask', result) as never,
        history: [],
        created_at: now,
        updated_at: now,
        version: 0,
      })
      .returning();
    await emitArtifactCreateEvent(tx, {
      row: artifactRowToCreateSnapshot(insertedArtifact),
      actorKind: 'agent',
      actorRef: 'quiz_gen',
      taskRunId: result.task_run_id ?? null,
      createdAt: now,
    });
  });
  return {
    questionIds,
    placementDrainOnlyIds,
    difficultyEvidenceByQuestion,
    exactDuplicates,
    compositePartCount,
    toolQuizArtifactId,
  };
}
