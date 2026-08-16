// YUK-892 (F4.0) — Practice-owned proposal tools, moved verbatim from the
// central src/server/ai/tools/proposal-tools.ts.
//
// author_question (ADR-0032 D8 unified question-authoring front door) and
// propose_question_edit (ADR-0032 D6-B / YUK-203 lane L6) are practice product
// operations: they propose only — the user accepts in the inbox; accept
// appliers live in practice/server/proposal-appliers.ts. Shared proposal
// inbox/writer machinery lives in @/kernel/proposals.

// ADR-0032 D6-B (YUK-203 lane L6) — the pure verify-gate is reused at PROPOSE
// time (pre-flight against the live tree) and again at ACCEPT time (the applier).
import type { VariantProposalResult } from '@/capabilities/practice/public';
import { applyQuestionEdit } from '@/capabilities/practice/public';
import { QuestionKind } from '@/core/schema/business';
// P5.6 / YUK-178 — the proactive/corrective discriminator the model can label
// explicitly via the propose-tool input arg (§4.1/§4.2).
import { SuggestionKind } from '@/core/schema/event/known';
import {
  type ProposalEvidenceRefT,
  QuestionEditOp,
  type QuestionEditOpT,
} from '@/core/schema/proposal';
import { SourceSpanLocator } from '@/core/schema/question-generation-grounding';
import type { Db } from '@/db/client';
import { question } from '@/db/schema';
import { pendingProposalWithCooldown } from '@/kernel/proposals/inbox';
import { writeAiProposal } from '@/kernel/proposals/writer';
import { getActiveLearningRecord } from '@/kernel/records/queries';
import type { DomainTool, ToolContext } from '@/kernel/tools/types';
import type { TaskTextRunFn } from '@/server/ai/provenance';
import { makeRunTaskFn } from '@/server/ai/runner-fn';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { runQuestionAuthor } from './question-author';

const TEXT_EXCERPT_MAX = 180;

function excerpt(value: string | null | undefined, max = TEXT_EXCERPT_MAX): string {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

// ---------------------------------------------------------------------------
// author_question  (ADR-0032 D8 — unified question-authoring front door)
// ---------------------------------------------------------------------------
//
// ADR-0032 D8 (docs/adr/0032-domaintool-surface-redesign.md:76-83): the three
// question-creation entry points share ONE `author_question` core keyed by a
// seeding mode:
//   - seed_mode='variant'           = the practice-owned Failure Learning path
//   - seed_mode='record'            = the existing record_promotion → question path
//   - seed_mode='knowledge'|'material' = ADR-0031 lane B (quiz C→A, YUK-304):
//                                        generate ONE original draft question via
//                                        the single-shot QuestionAuthorTask
//                                        (runQuestionAuthor) — draft row +
//                                        question_draft proposal in one tx;
//                                        accept promotes draft→active + FSRS.
//
// Minimal-risk unification boundary (grounded in the actual code):
//   * The variant seed DELEGATES to Failure Learning — every hard guard
//     (cause-targetable, depth≤2, chain terminus) and soft guard (in-flight cap,
//     cooldown) lives there and is preserved by construction (HARD INVARIANT #1/#3).
//   * The record seed writes `kind:'record_promotion'` with `target:'question'`
//     so the EXISTING `acceptRecordPromotionProposal` + its `existingAcceptRate`
//     idempotency (caused_by_event_id = proposalId) apply verbatim (HARD INVARIANT
//     #2). A1 introduces NO new proposal kind and touches NO accept-time code.
//   * The two legacy tools (propose_variant / propose_record_promotion) STAY as-is
//     with their exact contracts; `author_question` is an ADDITIVE front door, not
//     a replacement. (The legacy record tool still covers the wider
//     target∈{question,learning_item,artifact} surface; author_question's record
//     seed is deliberately the question-only sub-case per D8 "→question 支".)
//
// The public input remains a flat object with a `seed_mode` discriminator and
// per-mode optional fields. The cross-field "required-by-mode" check runs in
// `validateAuthorQuestionInput`
// (inside execute, OFF the schema), and the core maps the parsed input to an
// internal discriminated union for exhaustive dispatch.

// Internal discriminated union — exhaustive dispatch target. NOT the tool's
// inputSchema (the bridge requires a flat z.object — see note above).
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
      // ADR-0031 lane B (quiz C→A, YUK-304) — implemented: delegates to
      // runQuestionAuthor (practice/server/tools/question-author.ts), which owns
      // the proposal kind (question_draft) + the accept path. The accept applier
      // body is acceptQuestionDraftProposal in
      // src/capabilities/practice/server/proposal-appliers.ts (moved there in M4
      // YUK-319); src/server/proposals/actions.ts only DISPATCHES to it.
      seed_mode: 'knowledge' | 'material';
      knowledge_ids: string[];
      requested_kind?: string;
      difficulty?: number;
      material_body_md?: string;
      material_answer_anchor?: {
        canonical_answer: { kind: string; value: string };
        locator: z.infer<typeof SourceSpanLocator>;
      };
      material_url?: string;
      material_title?: string;
    };

// Public input schema — flat `z.object`. All per-mode fields are optional here;
// the cross-field "required-by-mode" check runs in
// `validateAuthorQuestionInput` inside execute (NOT on the schema), keeping the
// schema a pure ZodObject.
const AuthorQuestionInputSchema = z.object({
  seed_mode: z.enum(['variant', 'record', 'knowledge', 'material']),
  // variant seed
  attempt_event_id: z.string().min(1).optional(),
  // ADR-0032 D2 — count>1 is now allowed in principle; the variant core still
  // emits exactly one today, so accept only the literal 1 (forward-compatible).
  count: z.literal(1).optional(),
  // record seed
  record_id: z.string().min(1).optional(),
  reasoning: z.string().min(1).max(2000).optional(),
  draft: z.unknown().optional(),
  suggestion_kind: SuggestionKind.optional(),
  // knowledge | material seed (ADR-0031 lane B). material_body_md is bounded to
  // keep the single-shot QuestionAuthorTask prompt budget sane (20k chars ≈ a
  // long reading passage; longer pastes should be split by the model upstream).
  knowledge_ids: z.array(z.string().min(1)).min(1).optional(),
  requested_kind: z.string().min(1).optional(),
  difficulty: z.number().int().min(1).max(5).optional(),
  material_body_md: z.string().min(1).max(20_000).optional(),
  material_answer_anchor: z
    .object({
      canonical_answer: z.object({ kind: z.string().min(1), value: z.string().min(1) }),
      locator: SourceSpanLocator,
    })
    .optional(),
  material_url: z.string().url().optional(),
  material_title: z.string().min(1).optional(),
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
    case 'knowledge':
    case 'material':
      if (!input.knowledge_ids || input.knowledge_ids.length === 0) {
        throw new Error(
          `author_question seed_mode '${input.seed_mode}' requires non-empty knowledge_ids`,
        );
      }
      // material seed REQUIRES the pasted body: QuestionAuthorTask is a
      // single-shot structured call with NO fetch tool (决定6 — no Tavily), so a
      // URL-only seed would hallucinate the passage. material_url /
      // material_title are provenance-only metadata.
      if (input.seed_mode === 'material' && !input.material_body_md) {
        throw new Error("author_question seed_mode 'material' requires material_body_md");
      }
      if (input.seed_mode === 'material' && !input.material_answer_anchor) {
        throw new Error("author_question seed_mode 'material' requires material_answer_anchor");
      }
      break;
  }
}

const AuthorQuestionOutputSchema = z.object({
  status: z.enum([
    // shared
    'proposed',
    'failed',
    // knowledge|material seed (ADR-0031 lane B): every seed knowledge id is
    // unknown / archived.
    'skipped:knowledge_not_found',
    // variant passthrough (verbatim from RunVariantGenResult, names remapped to
    // match the propose_variant tool's external vocabulary)
    'skipped:attempt_not_found',
    'skipped:not_failure_attempt',
    'skipped:attempt_not_active',
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
  seed_mode: z.enum(['variant', 'record', 'knowledge', 'material']),
  proposal_ids: z.array(z.string()),
  mistake_variant_ids: z.array(z.string()),
  // Always [] today (no variant_question row exists pre-accept); surfaced for
  // forward-compat with the legacy propose_variant output and lane B.
  variant_question_ids: z.array(z.string()),
  // ADR-0031 lane B (ADDITIVE) — set ONLY by the knowledge|material seed: the
  // draft question row id(s) inserted at propose time, so the copilot can feed
  // the SAME id into write_quiz in the SAME turn (draft-allowed, RP-2).
  // variant/record seeds never set it — their contracts are untouched.
  question_ids: z.array(z.string()).optional(),
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
    case 'knowledge':
    case 'material':
      return {
        seed_mode: input.seed_mode,
        knowledge_ids: input.knowledge_ids as string[],
        ...(input.requested_kind ? { requested_kind: input.requested_kind } : {}),
        ...(input.difficulty !== undefined ? { difficulty: input.difficulty } : {}),
        ...(input.material_body_md ? { material_body_md: input.material_body_md } : {}),
        ...(input.material_answer_anchor
          ? { material_answer_anchor: input.material_answer_anchor }
          : {}),
        ...(input.material_url ? { material_url: input.material_url } : {}),
        ...(input.material_title ? { material_title: input.material_title } : {}),
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
    case 'knowledge':
    case 'material': {
      // ADR-0031 lane B (quiz C→A, YUK-304) — DELEGATE to runQuestionAuthor:
      // ONE single-shot QuestionAuthorTask call (决定6 — NOT the QuizGenTask
      // agent loop) → draft question row + question_draft proposal in one tx
      // (决定4/决定5 proposal-only; accept promotes draft→active + FSRS).
      // causedByEventId IS threaded here (like the record seed): the proposal's
      // causality anchors on the triggering chat/tool event.
      const result = await runQuestionAuthor(
        {
          seed_mode: seed.seed_mode,
          knowledge_ids: seed.knowledge_ids,
          ...(seed.requested_kind ? { requested_kind: seed.requested_kind } : {}),
          ...(seed.difficulty !== undefined ? { difficulty: seed.difficulty } : {}),
          ...(seed.material_body_md ? { material_body_md: seed.material_body_md } : {}),
          ...(seed.material_answer_anchor
            ? { material_answer_anchor: seed.material_answer_anchor }
            : {}),
          ...(seed.material_url ? { material_url: seed.material_url } : {}),
          ...(seed.material_title ? { material_title: seed.material_title } : {}),
        },
        {
          db: deps.db,
          actorRef: deps.actorRef,
          taskRunId: deps.taskRunId,
          ...(deps.causedByEventId ? { causedByEventId: deps.causedByEventId } : {}),
          runTaskFn,
        },
      );
      if (result.status !== 'proposed') {
        return {
          status: result.status,
          seed_mode: seed.seed_mode,
          proposal_ids: [],
          mistake_variant_ids: [],
          variant_question_ids: [],
        };
      }
      return {
        status: 'proposed',
        seed_mode: seed.seed_mode,
        proposal_ids: [result.proposalId],
        mistake_variant_ids: [],
        variant_question_ids: [],
        // The draft row id — feedable into write_quiz in the SAME turn (RP-2).
        question_ids: [result.questionId],
        reasoning_summary: `question_draft ${result.proposalId}`,
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
    'Author one question proposal via a seeding mode (ADR-0032 D8). seed_mode="variant" generates a targeted variant through the practice-owned Failure Learning guards; seed_mode="record" promotes a LearningRecord into a question draft; seed_mode="knowledge"|"material" generates ONE original draft question seeded by knowledge_ids (and, for "material", a pasted material_body_md — 材料 stem + sub_questions tree supported), inserts it as draft_status="draft", and writes a question_draft proposal whose accept promotes it to active + FSRS. The returned question_ids may be assembled into a paper via write_quiz in the same turn (drafts allowed). Proposal-only: the user accepts in the inbox; no draft ever enters the review pool without accept.',
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
