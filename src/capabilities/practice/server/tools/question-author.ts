// author_question seed core for teaching_draft / knowledge / material questions.
//
// YUK-1914：伙伴拟题不再走 legacy question 行 + question_draft 收件箱提案 —
// 一律经 teaching draft 声明文档 → persistDeclaredQuestionGroup 单缝入库，
// 与备题员切换共用同一条 save+submit+准入门，产出在题库可见的待准入题。
// knowledge/material 仍调 QuestionAuthorTask 产内容，但其输出也转成 v2
// 声明文档进同一缝。同一 task run 同内容重复调用靠确定性 request_id 重放。

import { createHash } from 'node:crypto';
import { and, inArray, isNull } from 'drizzle-orm';
import type { z } from 'zod';
import type { QuestionAuthorIntentSchema } from '@/ai/task-intents';
import { answerClassForKindLabel } from '@/core/schema/answer-class';
import { AgentRef } from '@/core/schema/business';
import {
  type QuestionAuthorDraftT,
  normalizeAuthorStructured,
} from '@/core/schema/question_author';
import {
  type QuestionDraftDocumentT,
  structuredQuestionToDraftDocument,
} from '@/core/schema/question-draft';
import {
  type QuestionAnswerAnchorT,
  validateSourceLocatorBytes,
} from '@/core/schema/question-generation-grounding';
import { canonicalQuestionContentHash } from '@/capabilities/practice/question-bank/server/quiz/content-fingerprint';
import type { Db, Tx } from '@/db/client';
import { knowledge } from '@/db/schema';
import { getEffectiveDomain } from '@/kernel/read-models/knowledge-tree';
import { draftCanonicalIdentity } from '@/kernel/records/question-draft-contract';
import type { ToolContext } from '@/kernel/tools/types';
import type { TaskTextRunFn } from '@/server/ai/provenance';
import {
  type DeclaredGroupPersistResult,
  persistDeclaredQuestionGroup,
} from '@/server/questions/shared-submit';
import { canonicalJson } from '@/server/questions/submit-decision';
import type { SubmitResult, SubmitUnitOutcome } from '@/server/questions/submit-question';
import { resolveSubjectProfile } from '@/subjects/profile';
import { normalizeToCanonicalKind } from '@/subjects/question-kind';
import { parseQuestionAuthorOutput } from '../../tasks/question-author';
import {
  type PrepareQuestionGenerationInput,
  bindGeneratedQuestion,
  canonicalSourceContentHash,
  markQuestionGenerationFailed,
  prepareQuestionGeneration,
} from '../question-generation-grounding';

// The single canonical kind a material plan defaults to when none is requested.
// A persisted plan's kind must equal the prompt kind and the verifier's
// comparison kind, so the default also constrains generation (see).
const DEFAULT_MATERIAL_QUESTION_KIND = 'short_answer';

export interface QuestionAuthorSeed {
  seed_mode: 'knowledge' | 'material';
  knowledge_ids: string[];
  /** Free-text type request: recognized kind labels constrain the author
   *  verbatim; anything else reaches it as a descriptive hint only. */
  requested_kind?: string;
  difficulty?: number;
  /** REQUIRED for seed_mode='material' (the task has no fetch tool — critic #5). */
  material_body_md?: string;
  /** REQUIRED source-grounded answer evidence for the material production path. */
  material_answer_anchor?: {
    canonical_answer: QuestionAnswerAnchorT['canonical_answer'];
    locator: QuestionAnswerAnchorT['source']['locator'];
  };
  /** Provenance-only metadata; never fetched (single-shot task, no Tavily). */
  material_url?: string;
  material_title?: string;
}

export interface QuestionAuthorDeps {
  db: Db;
  /** actor_ref for the written proposal (ctx.callerActor.ref). */
  actorRef: string;
  taskRunId: string;
  sessionId?: string;
  causedByEventId?: string;
  runTaskFn: TaskTextRunFn;
}

// ---------- shared submit seam ----------

export interface CopilotDraftSubmitDeps {
  db: Db;
  /** ctx.callerActor.ref — 归属与发布 actor 前缀。 */
  actorRef: string;
  taskRunId: string;
  /** Copilot 会话 id：草稿提交回执的会话谱系，准入 purpose 判定的来源。 */
  sessionId?: string;
  causedByEventId?: string;
  beforeWrite?: (tx: Tx) => Promise<void>;
}

export type CopilotDraftSubmitResult =
  | {
      status: 'submitted';
      questionId: string;
      /** 提交缝回执的准入态（新题通常 'withheld' = 已入库待准入跑完）。 */
      admission: 'admitted' | 'withheld' | 'pending';
      revisionId?: string;
      perUnit: SubmitUnitOutcome[];
      replayed: boolean;
    }
  | { status: 'withheld'; published: false; detail: string; perUnit: SubmitUnitOutcome[] }
  | { status: 'conflict'; reason: string; detail: string; questionId?: string }
  | { status: 'declaration_failed'; detail: string };

function submitReceiptToResult(submit: SubmitResult, replayed = false): CopilotDraftSubmitResult {
  if (submit.status === 'conflict') {
    return {
      status: 'conflict',
      reason: submit.reason,
      detail: submit.detail,
      ...(submit.question_id != null ? { questionId: submit.question_id } : {}),
    };
  }
  if ('published' in submit) {
    return { status: 'withheld', published: false, detail: submit.detail, perUnit: submit.per_unit };
  }
  return {
    status: 'submitted',
    questionId: submit.question_id,
    admission: submit.status,
    ...(submit.revision_id != null ? { revisionId: submit.revision_id } : {}),
    perUnit: submit.per_unit,
    replayed,
  };
}

/**
 * 声明文档 → 题库待准入的唯一写口。request_id 由内容指纹派生：同 run 重复
 * 同参调用按原回执重放，不同内容各自落新题 —— 一轮出多题是本意，不冷却。
 * metadata.teaching_draft 走 sourced 系统通道入 question.metadata；
 * doc.metadata 的副本只是草稿层留痕，不作权威。
 */
export async function submitCopilotAuthoredDraft(
  doc: QuestionDraftDocumentT,
  init: { question_kind: string; difficulty?: number },
  deps: CopilotDraftSubmitDeps,
): Promise<CopilotDraftSubmitResult> {
  const requestId = `author_question:${createHash('sha256')
    .update(canonicalJson({ document: doc, question_kind: init.question_kind }))
    .digest('hex')
    .slice(0, 24)}`;
  const result: DeclaredGroupPersistResult = await persistDeclaredQuestionGroup(deps.db, {
    document: doc,
    idNamespace: `yuk1914-author:${requestId}`,
    saveRequestId: `${requestId}:save`,
    submitRequestId: `${requestId}:submit`,
    availability: 'general_pool',
    sourced: {
      canonical_content_hash: canonicalQuestionContentHash(draftCanonicalIdentity(doc)),
      created_by: AgentRef.parse({
        by: 'ai',
        task_kind: 'author_question',
        task_run_id: deps.taskRunId,
      }),
      ...(init.difficulty !== undefined ? { difficulty: init.difficulty } : {}),
      metadata: {
        teaching_draft: {
          question_kind: init.question_kind,
          chat_origin: {
            ...(deps.sessionId != null ? { session_id: deps.sessionId } : {}),
            ...(deps.causedByEventId != null ? { turn_id: deps.causedByEventId } : {}),
          },
        },
      },
    },
    ctx: {
      actorRef: deps.actorRef,
      actorKind: 'agent',
      ...(deps.beforeWrite ? { beforeWrite: deps.beforeWrite } : {}),
      sessionId: deps.sessionId ?? null,
      taskRunId: deps.taskRunId,
      causedByEventId: deps.causedByEventId ?? null,
    },
  });
  switch (result.status) {
    case 'replayed':
      return submitReceiptToResult(result.receipt, true);
    case 'request_id_reused':
      return { status: 'conflict', reason: 'request_id_reused', detail: result.detail };
    case 'submit_rolled_back':
      return submitReceiptToResult(result.submit);
    case 'declaration_failed':
      return {
        status: 'declaration_failed',
        detail: result.issues.map((issue) => `${issue.code}: ${issue.detail}`).join('; '),
      };
    case 'save_failed':
      return {
        status: 'conflict',
        reason: result.save.status,
        detail:
          'detail' in result.save ? result.save.detail : `draft save ${result.save.status}`,
      };
    case 'completed':
      return submitReceiptToResult(result.submit);
    case 'submit_conflict':
      return submitReceiptToResult(result.submit);
  }
}

async function buildQuestionAuthorPreparation(db: Db, seed: QuestionAuthorSeed) {
  if (seed.seed_mode === 'material' && !seed.material_body_md?.trim()) {
    throw new Error("question_author seed_mode 'material' requires material_body_md");
  }

  if (seed.seed_mode === 'material' && !seed.material_answer_anchor) {
    throw new Error("question_author seed_mode 'material' requires material_answer_anchor");
  }

  if (seed.seed_mode === 'material' && seed.material_answer_anchor && seed.material_body_md) {
    const locator = seed.material_answer_anchor.locator;
    if (locator.kind !== 'text_span') {
      throw new Error(
        `question_author material locator '${locator.kind}' has no authoritative page content`,
      );
    }
    // Inline material is its own authoritative source; validate the locator's
    // half-open UTF-8 byte range via the shared grounding authority.
    validateSourceLocatorBytes(locator, new TextEncoder().encode(seed.material_body_md));
  }

  const wanted = [...new Set(seed.knowledge_ids)];
  const nodes = wanted.length
    ? await db
        .select({ id: knowledge.id, name: knowledge.name })
        .from(knowledge)
        .where(and(inArray(knowledge.id, wanted), isNull(knowledge.archived_at)))
    : [];
  if (nodes.length === 0) return null;

  const validIds = nodes.map((node) => node.id);
  const validIdSet = new Set(validIds);
  const firstValidId = wanted.find((id) => validIdSet.has(id)) ?? validIds[0];
  let effectiveDomain: string | null = null;
  try {
    effectiveDomain = await getEffectiveDomain(db, firstValidId);
  } catch {
    effectiveDomain = null;
  }
  // requested_kind splits two ways at plan-creation time. A label the kind
  // vocabulary recognizes (canonical or profile/skill, folded to canonical)
  // stays a HARD constraint — it reaches the prompt as requested_kind and, on
  // the material path, the persisted plan, so the verifier compares
  // like-for-like. Any other non-empty label is the caller's free-text wording
  // (「计算题」, a whole sentence): it reaches the author as requested_kind_hint
  // only — an input to judgement, not a gate — and the author resolves a real
  // structural kind plus a compatible judge route itself. Passing free text as
  // requested_kind made the sub-model echo it verbatim as kind and pick an
  // exact route, which the judge contract rejects (unknown kinds classify
  // semantic), killing solvable drafts.
  const requestedLabel = seed.requested_kind?.trim() ?? '';
  const canonicalRequestedKind = requestedLabel ? normalizeToCanonicalKind(requestedLabel) : null;
  const requestedKindHint =
    canonicalRequestedKind === null && requestedLabel.length > 0 ? requestedLabel : null;
  // The material path persists a plan whose requested_kind is veto-compared by
  // implied answer class, so an omitted kind still defaults to the canonical
  // material default. A free-text hint pins nothing: the prompt gets no
  // requested_kind and the plan records the resolved kind instead (below) —
  // persisting the raw label would veto valid exact/steps-class results.
  const effectiveKind =
    seed.seed_mode === 'material'
      ? requestedKindHint
        ? null
        : (canonicalRequestedKind ?? DEFAULT_MATERIAL_QUESTION_KIND)
      : canonicalRequestedKind;

  return {
    input: {
      seed_mode: seed.seed_mode,
      knowledge_context: nodes.map((node) => ({ id: node.id, name: node.name })),
      ...(effectiveKind ? { requested_kind: effectiveKind } : {}),
      ...(requestedKindHint ? { requested_kind_hint: requestedKindHint } : {}),
      ...(seed.difficulty !== undefined ? { requested_difficulty: seed.difficulty } : {}),
      ...(seed.material_body_md
        ? {
            material: {
              body_md: seed.material_body_md,
              ...(seed.material_title ? { title: seed.material_title } : {}),
            },
          }
        : {}),
    },
    ctx: { subjectProfile: resolveSubjectProfile(effectiveDomain) },
    validIds,
    validIdSet,
    effectiveKind,
    requestedKindHint,
  };
}

export async function prepareQuestionAuthorTask(
  ctx: Pick<ToolContext, 'db'>,
  seed: z.infer<typeof QuestionAuthorIntentSchema>,
) {
  const prepared = await buildQuestionAuthorPreparation(ctx.db, seed);
  if (!prepared) throw new Error('QuestionAuthorTask knowledge not found');
  return { input: prepared.input, ctx: prepared.ctx };
}

export type RunQuestionAuthorResult =
  | CopilotDraftSubmitResult
  | { status: 'skipped:knowledge_not_found' };

/**
 * Generate ONE question seeded by knowledge nodes and/or pasted material via
 * QuestionAuthorTask, then route the produced draft through the shared
 * save+submit seam — the question lands in the bank awaiting admission, with
 * no inbox proposal.
 *
 * Soft-skips (returns a status) only on a fully-invalid knowledge seed; every
 * other failure (LLM outage / parse failure / malformed tree) THROWS — the
 * DomainTool wrapper maps throws to status:'failed'.
 */
export async function runQuestionAuthor(
  seed: QuestionAuthorSeed,
  deps: QuestionAuthorDeps,
): Promise<RunQuestionAuthorResult> {
  const { db } = deps;

  const prepared = await buildQuestionAuthorPreparation(db, seed);
  if (!prepared) return { status: 'skipped:knowledge_not_found' };
  const { input, ctx: runCtx, validIds, validIdSet, effectiveKind, requestedKindHint } = prepared;

  let preparedGrounding:
    | Awaited<ReturnType<typeof prepareQuestionGeneration<QuestionAuthorDraftT>>>
    | undefined;
  let draft: QuestionAuthorDraftT;
  if (seed.seed_mode === 'material' && seed.material_body_md && seed.material_answer_anchor) {
    // Inline material IS the authoritative source; hash its exact UTF-8 bytes so
    // the recorded content_hash is byte-bound to what validates the locator.
    const authoritativeBytes = new TextEncoder().encode(seed.material_body_md);
    const sourceHash = canonicalSourceContentHash(authoritativeBytes);
    let generationResult: Awaited<ReturnType<QuestionAuthorDeps['runTaskFn']>> | undefined;
    const planCore: Omit<
      PrepareQuestionGenerationInput<QuestionAuthorDraftT>,
      'requestedKind' | 'requestedAnswerClass' | 'constraints' | 'generate'
    > = {
      source: {
        artifact_kind: 'inline_material',
        artifact_id: sourceHash,
        version: 1,
        content_hash: sourceHash,
        locator: seed.material_answer_anchor.locator,
      },
      // Its UTF-8 bytes validate the locator centrally (fail-closed, never
      // bypassed) and bind the content_hash above.
      authoritativeBytes,
      canonicalAnswer: seed.material_answer_anchor.canonical_answer,
      anchorProvenance: { kind: 'human_curated', task_run_id: deps.taskRunId },
      demand: { kind: 'knowledge', ref_id: validIds[0] },
      knowledgeIds: validIds,
      planProvenance: { kind: 'human_planned', task_run_id: deps.taskRunId },
    };
    if (requestedKindHint !== null) {
      // Free-text hint: nothing about the kind was formally constrained, so the
      // plan's requested_kind — veto-compared by implied answer class — records
      // the kind the request RESOLVED to, with the original wording kept in
      // constraints. Persisting the raw label would veto valid
      // exact/steps-class results; persisting the resolved kind also keeps the
      // requested_answer_class record truthful. The author runs first only in
      // this branch: a recognized constraint keeps plan-first order so a
      // disobedient output is still caught by the veto.
      generationResult = await deps.runTaskFn('QuestionAuthorTask', input, runCtx);
      const generated = parseQuestionAuthorOutput(generationResult.text);
      preparedGrounding = await prepareQuestionGeneration(db, {
        ...planCore,
        requestedKind: generated.kind,
        requestedAnswerClass: answerClassForKindLabel(generated.kind),
        constraints: { seed_mode: 'material', requested_kind_hint: requestedKindHint },
        generate: async () => generated,
      });
    } else {
      preparedGrounding = await prepareQuestionGeneration(db, {
        ...planCore,
        // Same kind label used for the prompt : the verifier compares
        // the generated label's implied answer class against this persisted value
        // (— label identity is no longer vetoed).
        requestedKind: effectiveKind ?? DEFAULT_MATERIAL_QUESTION_KIND,
        requestedAnswerClass: 'exact',
        constraints: { seed_mode: 'material' },
        generate: async () => {
          generationResult = await deps.runTaskFn('QuestionAuthorTask', input, runCtx);
          return parseQuestionAuthorOutput(generationResult.text);
        },
      });
    }
    if (!generationResult) throw new Error('QuestionAuthorTask completed without a task result');
    draft = preparedGrounding.generated;
  } else {
    const result = await deps.runTaskFn('QuestionAuthorTask', input, runCtx);
    draft = parseQuestionAuthorOutput(result.text);
  }

  try {
    // Hallucinated-id discipline: intersect the echoed knowledge_ids with the
    // validated seed set; an empty intersection falls back to the full validated
    // seed (the question was generated FOR those nodes — quiz_gen salvage policy).
    const echoed = draft.knowledge_ids.filter((id) => validIdSet.has(id));
    const questionKnowledgeIds = echoed.length > 0 ? echoed : validIds;

    // Server-side tree hardening: regenerate node ids, reject malformed shapes,
    // derive (and require non-empty) prompt_md / reference_md.
    const normalized = normalizeAuthorStructured(draft.structured);

    // The LLM tree becomes the declared v2 document — the same conversion the
    // draft seam already owns for legacy structured trees. Judge-executability
    // is the new seam's contract + admission gates, not the old kind-route
    // contract (assertGeneratedQuestionHasJudgeContract is retired on this path).
    const doc: QuestionDraftDocumentT = structuredQuestionToDraftDocument(normalized.structured);
    doc.knowledge_ids = questionKnowledgeIds;
    doc.source = { kind: 'generated', note: `author_question:${seed.seed_mode}` };
    doc.metadata = {
      ...doc.metadata,
      teaching_draft: {
        question_kind: draft.kind,
        chat_origin: {
          ...(deps.sessionId != null ? { session_id: deps.sessionId } : {}),
          ...(deps.causedByEventId != null ? { turn_id: deps.causedByEventId } : {}),
        },
      },
    };

    const submitted = await submitCopilotAuthoredDraft(
      doc,
      { question_kind: draft.kind, difficulty: draft.difficulty },
      {
        db,
        actorRef: deps.actorRef,
        taskRunId: deps.taskRunId,
        ...(deps.sessionId != null ? { sessionId: deps.sessionId } : {}),
        ...(deps.causedByEventId != null ? { causedByEventId: deps.causedByEventId } : {}),
      },
    );

    // Material-grounding evidence binds to the real question row after the
    // seam commits; a persist failure still marks the plan failed below.
    if (submitted.status === 'submitted' && preparedGrounding) {
      await db.transaction(async (tx) => {
        await bindGeneratedQuestion(tx, {
          questionId: submitted.questionId,
          plan: preparedGrounding.plan,
          anchor: preparedGrounding.anchor,
          generated: { kind: draft.kind },
        });
      });
    }

    return submitted;
  } catch (error) {
    // Best-effort durable failure marker: a cleanup throw must NOT mask the
    // original error — log it and always rethrow the original cause.
    if (preparedGrounding) {
      try {
        await markQuestionGenerationFailed(db, preparedGrounding.plan);
      } catch (cleanupError) {
        console.error(
          `[question-author] failed to mark plan ${preparedGrounding.plan.id} failed during cleanup`,
          cleanupError,
        );
      }
    }
    throw error;
  }
}
