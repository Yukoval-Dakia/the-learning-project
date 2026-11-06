import { sourceAllowsDerivation } from '@/kernel/read-models/usage-policy';
// New conversation questions are submitted directly; edits retain their proposal gate.

import { eq } from 'drizzle-orm';
import { z } from 'zod';
// ADR-0032 D6-B (YUK-203 lane L6) — the pure verify-gate is reused at PROPOSE
// time (pre-flight against the live tree) and again at ACCEPT time (the applier).
import type { VariantProposalResult } from '@/capabilities/practice/public';
import { applyQuestionEdit } from '@/capabilities/practice/question-bank/server/question-structure-edit';
import { QuestionKind } from '@/core/schema/business';
// P5.6 / YUK-178 — the proactive/corrective discriminator the model can label
// explicitly via the propose-tool input arg (§4.1/§4.2).
import { SuggestionKind } from '@/core/schema/event/known';
import { QuestionEditOp, type QuestionEditOpT } from '@/core/schema/proposal';
import {
  TeachingDraft,
  type TeachingDraftT,
  teachingDraftToDocument,
} from '@/core/schema/teaching-draft';
import type { Db } from '@/db/client';
import { question } from '@/db/schema';
import { pendingProposalWithCooldown } from '@/kernel/proposals/inbox';
import { writeAiProposal } from '@/kernel/proposals/writer';
import { getActiveLearningRecord } from '@/kernel/records/queries';
import { type DomainTool, OpaqueJsonInput, type ToolContext } from '@/kernel/tools/types';
import type { TaskTextRunFn } from '@/server/ai/provenance';
import { makeRunTaskFn } from '@/server/ai/runner-fn';

const TEXT_EXCERPT_MAX = 180;

function excerpt(value: string | null | undefined, max = TEXT_EXCERPT_MAX): string {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

type AuthorQuestionSeed =
  | { seed_mode: 'variant'; attempt_event_id: string }
  | {
      seed_mode: 'record';
      record_id: string;
      reasoning: string;
      draft?: unknown;
      suggestion_kind?: z.infer<typeof SuggestionKind>;
    }
  | {
      // Companion 直接写稿；服务端校验 TeachingDraft → 声明文档 →
      // persistDeclaredQuestionGroup（与备题员同一 save+submit+准入门）。
      seed_mode: 'teaching_draft';
      knowledge_ids: string[];
      draft: TeachingDraftT;
      difficulty?: number;
    };

// Public input schema — flat `z.object`. All per-mode fields are optional here;
// the cross-field "required-by-mode" check runs in
// `validateAuthorQuestionInput` inside execute (NOT on the schema), keeping the
// schema a pure ZodObject.
const AuthorQuestionInputSchema = z.object({
  seed_mode: z.enum(['variant', 'record', 'teaching_draft']),
  // variant seed
  attempt_event_id: z.string().min(1).optional(),
  // ADR-0032 D2 — count>1 is now allowed in principle; the variant core still
  // emits exactly one today, so accept only the literal 1 (forward-compatible).
  count: z.literal(1).optional(),
  // record seed
  record_id: z.string().min(1).optional(),
  reasoning: z.string().min(1).max(2000).optional(),
  // Opaque record-promotion draft, consumed by the record_promotion accept
  // applier; z.json instead of an unconstrained value (YUK-1553 C1-1).
  draft: OpaqueJsonInput.optional(),
  suggestion_kind: SuggestionKind.optional(),
  knowledge_ids: z.array(z.string().min(1)).min(1).optional(),
  difficulty: z.number().int().min(1).max(5).optional(),
});

// Cross-field required-by-mode validation. Kept OFF the schema (see note above)
// so the inputSchema stays a pure ZodObject the MCP bridge accepts. Throws on a
// missing per-mode field; the tool wrapper converts the throw to status:'failed'.
function validateAuthorQuestionInput(input: z.infer<typeof AuthorQuestionInputSchema>): void {
  switch (input.seed_mode) {
    case 'variant':
      if (!input.attempt_event_id) {
        throw new Error("author_question seed_mode 'variant' requires attempt_event_id");
      }
      break;
    case 'record':
      if (!input.record_id) {
        throw new Error("author_question seed_mode 'record' requires record_id");
      }
      if (!input.reasoning) {
        throw new Error("author_question seed_mode 'record' requires reasoning");
      }
      break;
    case 'teaching_draft':
      if (!input.knowledge_ids || input.knowledge_ids.length === 0) {
        throw new Error(
          "author_question seed_mode 'teaching_draft' requires non-empty knowledge_ids",
        );
      }
      if (input.draft === undefined) {
        throw new Error("author_question seed_mode 'teaching_draft' requires draft");
      }
      break;
  }
}

const AuthorQuestionOutputSchema = z.object({
  status: z.enum([
    // shared
    'proposed',
    'failed',
    // teaching_draft: 已入题库（published，
    // admission 字段给出待准入/通过/暂扣的提交回执）。
    'submitted',
    // 草稿已留但未发布（contract/group blocker）——不在题库；issues 给出原因。
    'withheld',
    // dedup/CAS/请求冲突 —— reason 字段给出 detail。
    'conflict',
    // knowledge|material seed (ADR-0031 lane B): every seed knowledge id is
    // unknown / archived.
    'skipped:knowledge_not_found',
    // variant passthrough (verbatim from RunVariantGenResult, names remapped to
    // match the propose_variant tool's external vocabulary)
    'skipped:attempt_not_found',
    'skipped:not_failure_attempt',
    'skipped:attempt_not_active',
    'skipped:source_purpose_restricted_or_unknown',
    'skipped:no_judge_yet',
    'skipped:question_not_found',
    'skipped:max_depth',
    'skipped:variant_chain_terminus',
    'skipped:cause_not_targetable',
    'skipped:already_has_variant',
    'skipped:variants_max_reached',
    // record passthrough
    'skipped:not_found',
    'skipped:duplicate_pending',
  ]),
  seed_mode: z.enum(['variant', 'record', 'teaching_draft']),
  proposal_ids: z.array(z.string()),
  mistake_variant_ids: z.array(z.string()),
  // Always [] today (no variant_question row exists pre-accept); surfaced for
  // forward-compat with the legacy propose_variant output and lane B.
  variant_question_ids: z.array(z.string()),
  // teaching_draft: the bank question id — visible
  // in the question bank, awaiting admission. NOT a proposal, no learner accept.
  question_id: z.string().optional(),
  question_ids: z.array(z.string()).optional(),
  // Where the learner sees the new question in the bank.
  bank_path: z.string().optional(),
  admission: z
    .object({
      state: z.enum(['admitted', 'withheld', 'pending']),
      per_unit: z.array(
        z.object({ unit_id: z.string(), status: z.string(), reason: z.string().optional() }),
      ),
    })
    .optional(),
  issues: z.array(z.object({ code: z.string(), detail: z.string() })).optional(),
  reasoning_summary: z.string().optional(),
});

type AuthorQuestionInput = z.infer<typeof AuthorQuestionInputSchema>;
type AuthorQuestionOutput = z.infer<typeof AuthorQuestionOutputSchema>;

export interface AuthorQuestionDeps {
  db: Db;
  /** ctx.callerActor.ref — actor_ref for any written proposal. */
  actorRef: string;
  /** ctx.taskRunId (non-nullable, matches ToolContext). */
  taskRunId: string;
  /** ctx.sessionId — the conversation the authoring came from (admission purpose lineage). */
  sessionId?: string;
  /** ctx.causedByEventId (optional, matches ToolContext). */
  causedByEventId?: string;
  /** Injectable for tests; the variant seed defaults to the central AI runner. */
  runTaskFn?: TaskTextRunFn;
}

// Map the flat parsed tool input onto the internal discriminated union. In the
// execute path `validateAuthorQuestionInput` (run before this) guarantees the
// per-mode fields are present, so the non-null assertions here are sound. When
// `authorQuestion()` is called directly (e.g. tests), the same per-mode
// presence is the caller's responsibility.
function toAuthorQuestionSeed(input: AuthorQuestionInput): AuthorQuestionSeed {
  switch (input.seed_mode) {
    case 'variant':
      return { seed_mode: 'variant', attempt_event_id: input.attempt_event_id as string };
    case 'record':
      return {
        seed_mode: 'record',
        record_id: input.record_id as string,
        reasoning: input.reasoning as string,
        ...(input.draft !== undefined ? { draft: input.draft } : {}),
        ...(input.suggestion_kind ? { suggestion_kind: input.suggestion_kind } : {}),
      };
    case 'teaching_draft':
      return {
        seed_mode: 'teaching_draft',
        knowledge_ids: input.knowledge_ids as string[],
        draft: TeachingDraft.parse(input.draft),
        difficulty: input.difficulty,
      };
  }
}

// Remap Failure Learning's internal status vocabulary to the propose_variant tool's
// external vocabulary (only `not_a_failure_attempt` → `not_failure_attempt`
// differs). Byte-identical to proposeVariantExecute's inline remap.
function remapVariantSkipStatus(
  status: Exclude<VariantProposalResult['status'], 'proposed' | 'failed:invalid_model_output'>,
): AuthorQuestionOutput['status'] {
  return status === 'skipped:not_a_failure_attempt' ? 'skipped:not_failure_attempt' : status;
}

/**
 * The shared question-authoring core (ADR-0032 D8). Dispatches by seed mode to
 * the existing, unchanged code paths. Soft-fails (returns a `skipped:*` status)
 * on guard rejections; throws only on genuinely unexpected errors (the tool
 * wrapper converts those to `status:'failed'`).
 */
export async function authorQuestion(
  seed: AuthorQuestionSeed,
  deps: AuthorQuestionDeps,
): Promise<AuthorQuestionOutput> {
  const runTaskFn = deps.runTaskFn ?? makeRunTaskFn(deps.db);
  switch (seed.seed_mode) {
    case 'variant': {
      // DELEGATE to the practice-owned Failure Learning operation — all variant
      // guards live there. `deps.causedByEventId` is intentionally NOT forwarded:
      // the operation owns the variant proposal's domain provenance. Only the `record` seed below
      // threads causedByEventId — the asymmetry is by design, not a miss.
      // Load the public owner facet only when this seed actually executes. The
      // Practice public barrel also exposes request handlers with production DB
      // defaults, so eager import would make schema-only tool registration perform
      // unrelated runtime initialization.
      const { proposeFailureVariant } = await import('@/capabilities/practice/public');
      const result = await proposeFailureVariant({
        db: deps.db,
        attemptEventId: seed.attempt_event_id,
        runTaskFn,
      });
      if (result.status === 'failed:invalid_model_output') {
        return {
          status: 'failed',
          seed_mode: 'variant',
          proposal_ids: [],
          mistake_variant_ids: [],
          variant_question_ids: [],
          reasoning_summary: result.reason,
        };
      }
      if (result.status !== 'proposed') {
        return {
          status: remapVariantSkipStatus(result.status),
          seed_mode: 'variant',
          proposal_ids: [],
          mistake_variant_ids: [],
          variant_question_ids: [],
        };
      }
      return {
        // The unified front door normalizes variant success to 'proposed' (the
        // legacy propose_variant tool keeps emitting 'generated' — its contract
        // is untouched; this tool uses one shared success vocabulary).
        status: 'proposed',
        seed_mode: 'variant',
        proposal_ids: result.proposal_id ? [result.proposal_id] : [],
        mistake_variant_ids: result.mistake_variant_id ? [result.mistake_variant_id] : [],
        variant_question_ids: [],
        reasoning_summary: result.proposal_id ? `proposal ${result.proposal_id}` : undefined,
      };
    }
    case 'record': {
      // INLINED from the ingestion-owned record promotion tool, pinned to
      // target:'question' (the D8 "record → question" sub-case). Writes
      // kind:'record_promotion' so the unchanged accept path + idempotency apply
      // verbatim (HARD INVARIANT #2).
      if (!(await getActiveLearningRecord(deps.db, seed.record_id))) {
        return {
          status: 'skipped:not_found',
          seed_mode: 'record',
          proposal_ids: [],
          mistake_variant_ids: [],
          variant_question_ids: [],
        };
      }
      if (!(await sourceAllowsDerivation(deps.db, { kind: 'record', id: seed.record_id }))) {
        return {
          status: 'skipped:source_purpose_restricted_or_unknown',
          seed_mode: 'record',
          proposal_ids: [],
          mistake_variant_ids: [],
          variant_question_ids: [],
        };
      }
      // Same cooldown namespace the legacy tool uses for target=question, so a
      // record promoted via either entry point dedups against the other.
      const cooldownKey = `record_promotion:${seed.record_id}:question`;
      if (await pendingProposalWithCooldown(deps.db, 'record_promotion', cooldownKey)) {
        return {
          status: 'skipped:duplicate_pending',
          seed_mode: 'record',
          proposal_ids: [],
          mistake_variant_ids: [],
          variant_question_ids: [],
        };
      }
      const proposalId = await writeAiProposal(deps.db, {
        actor_ref: deps.actorRef,
        payload: {
          kind: 'record_promotion',
          target: { subject_kind: 'record', subject_id: seed.record_id },
          reason_md: seed.reasoning,
          evidence_refs: [{ kind: 'record', id: seed.record_id }],
          proposed_change: {
            record_id: seed.record_id,
            target: 'question',
            ...(seed.draft !== undefined ? { draft: seed.draft } : {}),
          },
          rollback_plan: {
            action: 'dismiss proposal; no stronger learning object is created',
          },
          cooldown_key: cooldownKey,
          suggestion_kind: seed.suggestion_kind ?? 'proactive',
        },
        task_run_id: deps.taskRunId,
        caused_by_event_id: deps.causedByEventId ?? null,
      });
      return {
        status: 'proposed',
        seed_mode: 'record',
        proposal_ids: [proposalId],
        mistake_variant_ids: [],
        variant_question_ids: [],
        reasoning_summary: `record_promotion ${proposalId}`,
      };
    }
    case 'teaching_draft': {
      const { submitCopilotAuthoredDraft } = await import('@/capabilities/practice/public');
      const draft = TeachingDraft.parse(seed.draft);
      const result = await submitCopilotAuthoredDraft(
        teachingDraftToDocument(draft, {
          knowledge_ids: seed.knowledge_ids,
          origin: { session_id: deps.sessionId, turn_id: deps.causedByEventId },
        }),
        { question_kind: draft.response.form, difficulty: seed.difficulty },
        deps,
      );
      const base = {
        seed_mode: seed.seed_mode,
        proposal_ids: [],
        mistake_variant_ids: [],
        variant_question_ids: [],
      };
      if (result.status === 'declaration_failed')
        return {
          ...base,
          status: 'failed',
          reasoning_summary: result.issues.map((i) => i.detail).join('; '),
        };
      if (result.status === 'request_id_reused')
        return { ...base, status: 'conflict', reasoning_summary: result.detail };
      if (result.status === 'save_failed')
        return { ...base, status: 'failed', reasoning_summary: JSON.stringify(result.save) };
      const submit = result.status === 'replayed' ? result.receipt : result.submit;
      if (submit.status === 'conflict')
        return { ...base, status: 'conflict', reasoning_summary: submit.detail };
      if ('published' in submit)
        return { ...base, status: 'withheld', reasoning_summary: submit.detail };
      return {
        ...base,
        status: 'submitted',
        question_id: submit.question_id,
        question_ids: [submit.question_id],
        bank_path: `/questions/${submit.question_id}`,
        admission: { state: submit.status, per_unit: submit.per_unit },
        reasoning_summary: submit.per_unit.some((unit) => unit.reason === 'no_admitted_executor')
          ? '题已存入题库，但这类题目前没有可用的自动判分器，暂时不能作答；可以换一道选择、填空、配对、断句或排序题。'
          : '题已存入题库，自动检查通过后才能作答；请打开题库链接查看状态和原因。',
      };
    }
  }
}

async function authorQuestionExecute(
  ctx: ToolContext,
  raw: AuthorQuestionInput,
): Promise<AuthorQuestionOutput> {
  const input = AuthorQuestionInputSchema.parse(raw);
  try {
    validateAuthorQuestionInput(input);
    const seed = toAuthorQuestionSeed(input);
    return await authorQuestion(seed, {
      db: ctx.db,
      actorRef: ctx.callerActor.ref,
      taskRunId: ctx.taskRunId,
      causedByEventId: ctx.causedByEventId,
      sessionId: ctx.sessionId,
      runTaskFn: makeRunTaskFn(ctx.db, {
        signal: ctx.signal,
        parentTaskRunId: ctx.taskRunId,
        ...(ctx.providerSessionDeadlineAt !== undefined
          ? { providerSessionDeadlineAt: ctx.providerSessionDeadlineAt }
          : {}),
      }),
    });
  } catch (err) {
    return {
      status: 'failed',
      seed_mode: input.seed_mode,
      proposal_ids: [],
      mistake_variant_ids: [],
      variant_question_ids: [],
      reasoning_summary: err instanceof Error ? err.message : String(err),
    };
  }
}

export const authorQuestionTool: DomainTool<AuthorQuestionInput, AuthorQuestionOutput> = {
  name: 'author_question',
  description:
    'Create one question with seed_mode="teaching_draft": write draft={stem_md,response,solution_md?} yourself, with confirmed knowledge_ids. response.form: single_choice(options,answer_index), multi_choice(options,answer_indices), blank(blanks:[{answer,accepted?,numeric?}]), matching(left,right,pairs of zero-based indices), break_tap(segments), ordering(objects_in_order). No nested author task. The question goes directly into the bank for automatic admission, with no inbox confirmation. Only admitted questions can be practiced; use bank_path in your reply to show where checks and failure reasons appear. Free response is not supported for first-day practice: if supplied it stays withheld until a grading slice is admitted; explain and offer a deterministic question. variant and record seeds retain their existing proposal paths.',

  effect: 'propose',
  inputSchema: AuthorQuestionInputSchema,
  outputSchema: AuthorQuestionOutputSchema,
  // One DomainTool carries one cost class; the variant seed triggers an LLM gen
  // (VariantGenTask) while the record seed is local-only. 'cheap_llm' is the
  // truthful upper bound — cost class is an advisory hint, not a hard meter
  // (project warning-vs-hard-limit convention).
  costClass: 'cheap_llm',
  execute: authorQuestionExecute,
  summarize(input, output) {
    return `author_question[${input.seed_mode}]: ${output.status}`;
  },
  mirrorEvent: 'when_causal',
};

// ---------------------------------------------------------------------------
// propose_question_edit  (ADR-0032 D6-B / YUK-203 lane L6)
// ---------------------------------------------------------------------------
//
// Propose a NARROW, typed edit to one node of an ACTIVE (pooled,
// draft_status='active') question's `structured` tree. Proposal-only: the user
// accepts in the inbox; the accept applier (acceptQuestionEditProposal, practice
// package) re-runs the mini verify gate and applies the edit to
// question.structured behind a reversible audit event — never a direct write.
//
// Nodes are addressed by `node_id` — the SAME id/role coordinate the L5
// addressable projection exposes via get_question_context(include:['structure']):
// read the structure, pick a node id, edit that node id (read≡write parity).
//
// Bridge constraint (mcp-bridge.ts:145 — inputSchema MUST be a flat z.ZodObject):
// the public input is a FLAT object with an `op` discriminator + per-op optional
// fields; the typed op is resolved + validated (against the core QuestionEditOp
// discriminated union) inside execute, OFF the schema.

const ProposeQuestionEditInputSchema = z.object({
  question_id: z.string().min(1),
  op: z.enum(['edit_node_text', 'edit_reference', 'set_choice', 'set_node_kind']),
  node_id: z.string().min(1),
  // edit_node_text
  prompt_text: z.string().min(1).optional(),
  // edit_reference (at least one of answers/analysis required, checked in execute)
  answers: z.array(z.string()).optional(),
  analysis: z.string().optional(),
  // set_choice
  options: z
    .array(z.object({ label: z.string().min(1), text: z.string() }))
    .min(1)
    .optional(),
  // set_node_kind
  kind: QuestionKind.optional(),
  // optional human-readable rationale surfaced on the inbox card.
  reason: z.string().min(1).max(2000).optional(),
  suggestion_kind: SuggestionKind.optional(),
});
type ProposeQuestionEditInput = z.infer<typeof ProposeQuestionEditInputSchema>;

const ProposeQuestionEditOutputSchema = z.object({
  status: z.enum([
    'proposed',
    'skipped:not_found', // question row missing
    'skipped:not_active', // question is draft / re-drafted (not pooled)
    'skipped:no_structure', // question has no structured tree to address
    'skipped:invalid_op', // per-op fields missing / malformed
    'skipped:gate_rejected', // verify gate rejected (node missing / wrong shape / breaks invariants)
    'skipped:duplicate_pending', // an identical edit proposal is already pending
  ]),
  question_id: z.string(),
  node_id: z.string(),
  op: z.string(),
  proposal_id: z.string().optional(),
  // The verify-gate failure code on status='skipped:gate_rejected'.
  gate_failure: z.string().optional(),
});
type ProposeQuestionEditOutput = z.infer<typeof ProposeQuestionEditOutputSchema>;

/**
 * Resolve the flat tool input to the typed core QuestionEditOp, or null when the
 * per-op required fields are missing/malformed. Validated through the core
 * discriminated union so the proposal payload and the accept applier agree on
 * the exact op shape.
 */
function resolveQuestionEditOp(input: ProposeQuestionEditInput): QuestionEditOpT | null {
  let candidate: unknown;
  switch (input.op) {
    case 'edit_node_text':
      candidate = { op: 'edit_node_text', node_id: input.node_id, prompt_text: input.prompt_text };
      break;
    case 'edit_reference':
      candidate = {
        op: 'edit_reference',
        node_id: input.node_id,
        ...(input.answers !== undefined ? { answers: input.answers } : {}),
        ...(input.analysis !== undefined ? { analysis: input.analysis } : {}),
      };
      break;
    case 'set_choice':
      candidate = { op: 'set_choice', node_id: input.node_id, options: input.options };
      break;
    case 'set_node_kind':
      candidate = { op: 'set_node_kind', node_id: input.node_id, kind: input.kind };
      break;
  }
  const parsed = QuestionEditOp.safeParse(candidate);
  if (!parsed.success) return null;
  // edit_reference must change at least one of answers/analysis (the schema marks
  // both optional individually; the cross-field requirement lives here).
  if (
    parsed.data.op === 'edit_reference' &&
    parsed.data.answers === undefined &&
    parsed.data.analysis === undefined
  ) {
    return null;
  }
  return parsed.data;
}

async function proposeQuestionEditExecute(
  ctx: ToolContext,
  raw: ProposeQuestionEditInput,
): Promise<ProposeQuestionEditOutput> {
  const input = ProposeQuestionEditInputSchema.parse(raw);
  const base = { question_id: input.question_id, node_id: input.node_id, op: input.op };

  const edit = resolveQuestionEditOp(input);
  if (!edit) return { ...base, status: 'skipped:invalid_op' };

  const row = (
    await ctx.db.select().from(question).where(eq(question.id, input.question_id)).limit(1)
  )[0];
  if (!row) return { ...base, status: 'skipped:not_found' };
  if (row.draft_status !== 'active') return { ...base, status: 'skipped:not_active' };
  if (!row.structured) return { ...base, status: 'skipped:no_structure' };

  // Pre-flight the SAME mini verify gate the accept applier runs, against the
  // live tree — so a doomed edit never even becomes a pending proposal.
  const gated = applyQuestionEdit(row.structured, edit, ctx.callerActor.ref);
  if ('failure' in gated) {
    return { ...base, status: 'skipped:gate_rejected', gate_failure: gated.failure };
  }

  // Dedup: one pending edit per (question, node, op).
  const cooldownKey = `question_edit:${input.question_id}:${input.node_id}:${input.op}`;
  if (await pendingProposalWithCooldown(ctx.db, 'question_edit', cooldownKey)) {
    return { ...base, status: 'skipped:duplicate_pending' };
  }

  const proposalId = await writeAiProposal(ctx.db, {
    actor_ref: ctx.callerActor.ref,
    payload: {
      kind: 'question_edit',
      target: { subject_kind: 'question', subject_id: input.question_id },
      reason_md: input.reason ?? `propose structured ${input.op} on question ${input.question_id}`,
      evidence_refs: [{ kind: 'question', id: input.question_id }],
      proposed_change: {
        question_id: input.question_id,
        edit,
        // gated.after is snapshotNode(editedNode); prompt_text is a required
        // StructuredQuestion field, so the snapshot always carries it (no fallback).
        node_preview: excerpt(gated.after.prompt_text),
      },
      rollback_plan: {
        action: 'dismiss proposal; the active question structure is unchanged',
      },
      cooldown_key: cooldownKey,
      suggestion_kind: input.suggestion_kind ?? 'proactive',
    },
    task_run_id: ctx.taskRunId,
    caused_by_event_id: ctx.causedByEventId ?? null,
  });

  return { ...base, status: 'proposed', proposal_id: proposalId };
}

export const proposeQuestionEditTool: DomainTool<
  ProposeQuestionEditInput,
  ProposeQuestionEditOutput
> = {
  name: 'propose_question_edit',
  description:
    'Propose a narrow, typed edit to ONE node of an ACTIVE (pooled) question\'s structured tree. Address the node by its node_id from get_question_context(include:["structure"]) — same coordinate you read. op="edit_node_text" rewrites a node\'s prompt_text (stem passage / 题面); op="edit_reference" replaces a leaf node\'s answers and/or analysis (参考答案/解析); op="set_choice" replaces a leaf node\'s option list; op="set_node_kind" sets the advisory question-type hint. Proposal-only: the user accepts in the inbox; a mini verify gate re-checks the edit (node exists, correct node shape, structure invariants hold) before it is applied, reversibly, to question.structured. Skips (does not propose) on a missing/non-active question, missing structure, an invalid op, a gate rejection, or a duplicate pending edit.',
  effect: 'propose',
  inputSchema: ProposeQuestionEditInputSchema,
  outputSchema: ProposeQuestionEditOutputSchema,
  costClass: 'local',
  execute: proposeQuestionEditExecute,
  summarize(input, output) {
    return `propose_question_edit[${input.op}] ${input.node_id.slice(0, 8)}: ${output.status}`;
  },
  mirrorEvent: 'when_causal',
};
