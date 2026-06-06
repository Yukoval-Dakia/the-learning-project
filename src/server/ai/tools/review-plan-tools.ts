// YUK-203 U4 / D5 / CO §6.1 — the 4 ReviewPlanTask DomainTools.
//
// ReviewPlanTask is a tactical planner with a narrow, dedicated surface
// (`review_plan` in allowlists.ts). It consumes the Coach strategic brief as
// its ONLY attention prior and READS NO MEMORY (D7 / CO §6.1:664-666). These
// tools never mutate FSRS / due_at / question.metadata / coverage, do no
// question CRUD, and write no judge events (CO §6.1 forbidden writes). The only
// write is `write_review_plan`, which emits a `tool_quiz` paper artifact using
// the EXISTING flat ToolState shape (ToolStateT v2 is U5 scope — D3 §4-①).

import { ToolState, type ToolStateSectionT } from '@/core/schema/business';
import { ReviewSessionProposal } from '@/core/schema/coach';
import { compareBySourceTierThenWhitelist } from '@/core/schema/provenance';
import { artifact, knowledge, knowledge_mastery, question } from '@/db/schema';
import { getLatestCoachPlan } from '@/server/today/coach-plan';
import { createId } from '@paralleldrive/cuid2';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { executeGetReviewDue } from './context-readers';
import type { DomainTool, ToolContext } from './types';

// ───────────────────────────────────────────────────────────────────────────
// read_coach_brief — the single attention-prior channel.
// ───────────────────────────────────────────────────────────────────────────
//
// Cross-统合 correction: getLatestCoachPlan returns a CoachPlanView, NOT a bare
// TodayPlanT. The brief lives at view.daily_plan?.review_session_proposal.
//
// Degrade semantics (D5:29 / Cross-统合 §④, two distinct predicates):
//   - reason:'no_plan'    — no daily coach run in the 25-event scan window
//                           (daily_plan === null).
//   - reason:'empty_brief' — a daily plan exists but the brief's new fields are
//                            all empty (knowledge_focus.length===0 &&
//                            subject_mix.length===0). TodayPlan.review_session_
//                            proposal is a REQUIRED field, so it is never null
//                            when daily_plan exists — empty-brief is an explicit
//                            content predicate, not a null check.
// Both fall back to pure due-pressure: the planner drives the snapshot +
// candidate tools off the due queue alone with no attention prior.

const ReadCoachBriefInputSchema = z.object({
  // Reserved for symmetry with CO §6.1 `read_coach_brief(scope_key?)`. The brief
  // is global today (one TodayPlan per coach run); scopeKey is accepted but does
  // not yet filter — documented passthrough until multi-scope briefs land.
  scopeKey: z.string().optional(),
});
type ReadCoachBriefInput = z.infer<typeof ReadCoachBriefInputSchema>;

const ReadCoachBriefOutputSchema = z.object({
  brief: ReviewSessionProposal.nullable(),
  /** Set ONLY when degrading to pure due-pressure. null on the happy path. */
  reason: z.enum(['no_plan', 'empty_brief']).nullable(),
  daily_ran_at: z.string().nullable(),
});
// z.input: the brief embeds ReviewSessionProposal whose .default() fields make
// z.input ≠ z.output. The DomainTool's outputSchema is typed z.ZodType<Output>,
// which is only assignable from a ZodObject when Output is its INPUT type (Zod
// schemas are invariant on input). The execute path returns fully-parsed briefs
// (all fields present), which is assignable to the input type's optional fields.
type ReadCoachBriefOutput = z.input<typeof ReadCoachBriefOutputSchema>;

async function executeReadCoachBrief(
  ctx: ToolContext,
  _input: ReadCoachBriefInput,
): Promise<ReadCoachBriefOutput> {
  const view = await getLatestCoachPlan(ctx.db);
  const dailyPlan = view.daily_plan;
  if (dailyPlan == null) {
    return { brief: null, reason: 'no_plan', daily_ran_at: view.daily_ran_at };
  }
  const brief = dailyPlan.review_session_proposal;
  const isEmpty = brief.knowledge_focus.length === 0 && brief.subject_mix.length === 0;
  return {
    brief,
    reason: isEmpty ? 'empty_brief' : null,
    daily_ran_at: view.daily_ran_at,
  };
}

export const readCoachBriefTool: DomainTool<ReadCoachBriefInput, ReadCoachBriefOutput> = {
  name: 'read_coach_brief',
  description:
    "Read the latest Coach strategic review brief (the review_session_proposal from the newest daily coach run). This is the ONLY attention prior the planner sees — it does NOT read memory. Returns reason:'no_plan' when no daily coach run exists in the scan window, or reason:'empty_brief' when a plan exists but its brief fields (knowledge_focus / subject_mix) are empty; in both degrade cases plan off the due queue alone (pure due-pressure).",
  effect: 'read',
  inputSchema: ReadCoachBriefInputSchema,
  outputSchema: ReadCoachBriefOutputSchema,
  costClass: 'local',
  execute: executeReadCoachBrief,
  summarize(_input, output) {
    if (output.reason) return `coach brief · degrade=${output.reason}`;
    return `coach brief · focus=${output.brief?.knowledge_focus?.length ?? 0} · mix=${output.brief?.subject_mix?.length ?? 0}`;
  },
  mirrorEvent: 'never',
};

// ───────────────────────────────────────────────────────────────────────────
// get_review_knowledge_snapshot — due / weak / uncertain / recent-failure /
// goal-relevant knowledge state (CO §6.1:683-684).
// ───────────────────────────────────────────────────────────────────────────
//
// Reuses the public executeGetReviewDue path (due + never-reviewed-failure rows
// with knowledge_ids) and overlays mastery from the knowledge_mastery view
// (ADR-0012: mastery is a derived view, never stored columns — CO §7.1:730). No
// raw FSRS / coverage SQL; no mutation.

const GetReviewKnowledgeSnapshotInputSchema = z.object({
  // Optional knowledge_ids focus (e.g. from the brief's knowledge_focus). When
  // omitted, the due queue's natural ordering drives the snapshot.
  knowledgeIds: z.array(z.string().min(1)).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});
type GetReviewKnowledgeSnapshotInput = z.infer<typeof GetReviewKnowledgeSnapshotInputSchema>;

const GetReviewKnowledgeSnapshotOutputSchema = z.object({
  knowledge: z.array(
    z.object({
      knowledge_id: z.string(),
      name: z.string().nullable(),
      mastery: z.number().nullable(),
      evidence_count: z.number().int(),
      due_question_count: z.number().int(),
      never_reviewed_failure_count: z.number().int(),
      signals: z.array(z.enum(['due', 'weak', 'uncertain', 'recent_failure'])),
    }),
  ),
  summary: z.object({
    total_knowledge: z.number().int(),
    due_count: z.number().int(),
    weak_count: z.number().int(),
  }),
});
type GetReviewKnowledgeSnapshotOutput = z.infer<typeof GetReviewKnowledgeSnapshotOutputSchema>;

const WEAK_MASTERY_THRESHOLD = 0.55;

async function executeGetReviewKnowledgeSnapshot(
  ctx: ToolContext,
  input: GetReviewKnowledgeSnapshotInput,
): Promise<GetReviewKnowledgeSnapshotOutput> {
  const limit = input.limit ?? 30;
  // Reuse the deterministic review-due queue (public path, inherits the Guard-B
  // draft filter). Each row carries knowledge_ids + reason (overdue /
  // never_reviewed_failure).
  const due = await executeGetReviewDue(ctx, {
    knowledgeIds: input.knowledgeIds,
    limit,
  });

  type Agg = {
    due_question_count: number;
    never_reviewed_failure_count: number;
  };
  const byKnowledge = new Map<string, Agg>();
  for (const row of due.rows) {
    for (const kid of row.knowledge_ids) {
      const agg = byKnowledge.get(kid) ?? {
        due_question_count: 0,
        never_reviewed_failure_count: 0,
      };
      if (row.reason === 'never_reviewed_failure') agg.never_reviewed_failure_count += 1;
      else agg.due_question_count += 1;
      byKnowledge.set(kid, agg);
    }
  }
  // Union the explicit focus ids (so a focused-but-not-due node still surfaces
  // its mastery) with the due-derived ids.
  const knowledgeIds = new Set<string>(byKnowledge.keys());
  for (const kid of input.knowledgeIds ?? []) knowledgeIds.add(kid);
  const ids = [...knowledgeIds];

  const masteryRows =
    ids.length > 0
      ? await ctx.db
          .select({
            knowledge_id: knowledge_mastery.knowledge_id,
            mastery: knowledge_mastery.mastery,
            evidence_count: knowledge_mastery.evidence_count,
          })
          .from(knowledge_mastery)
          .where(inArray(knowledge_mastery.knowledge_id, ids))
      : [];
  const masteryById = new Map(masteryRows.map((r) => [r.knowledge_id, r]));

  const nameRows =
    ids.length > 0
      ? await ctx.db
          .select({ id: knowledge.id, name: knowledge.name })
          .from(knowledge)
          .where(inArray(knowledge.id, ids))
      : [];
  const nameById = new Map(nameRows.map((r) => [r.id, r.name]));

  let dueCount = 0;
  let weakCount = 0;
  const knowledgeOut: GetReviewKnowledgeSnapshotOutput['knowledge'] = ids.map((kid) => {
    const agg = byKnowledge.get(kid);
    const m = masteryById.get(kid);
    const mastery = m?.mastery ?? null;
    const evidenceCount = m?.evidence_count ?? 0;
    const signals: GetReviewKnowledgeSnapshotOutput['knowledge'][number]['signals'] = [];
    if ((agg?.due_question_count ?? 0) > 0) signals.push('due');
    if (typeof mastery === 'number' && mastery < WEAK_MASTERY_THRESHOLD) signals.push('weak');
    // uncertain = a node with some focus / due interest but no mastery evidence yet.
    if (mastery === null && evidenceCount === 0) signals.push('uncertain');
    if ((agg?.never_reviewed_failure_count ?? 0) > 0) signals.push('recent_failure');
    if (signals.includes('due')) dueCount += 1;
    if (signals.includes('weak')) weakCount += 1;
    return {
      knowledge_id: kid,
      name: nameById.get(kid) ?? null,
      mastery,
      evidence_count: evidenceCount,
      due_question_count: agg?.due_question_count ?? 0,
      never_reviewed_failure_count: agg?.never_reviewed_failure_count ?? 0,
      signals,
    };
  });

  return {
    knowledge: knowledgeOut,
    summary: {
      total_knowledge: knowledgeOut.length,
      due_count: dueCount,
      weak_count: weakCount,
    },
  };
}

export const getReviewKnowledgeSnapshotTool: DomainTool<
  GetReviewKnowledgeSnapshotInput,
  GetReviewKnowledgeSnapshotOutput
> = {
  name: 'get_review_knowledge_snapshot',
  description:
    'Read the review-relevant knowledge state: due / weak / uncertain / recent-failure signals per knowledge node, with mastery from the knowledge_mastery view (derived, never stored). Optionally focus on knowledge_ids. Read-only; never mutates FSRS / mastery.',
  effect: 'read',
  inputSchema: GetReviewKnowledgeSnapshotInputSchema,
  outputSchema: GetReviewKnowledgeSnapshotOutputSchema,
  costClass: 'local',
  execute: executeGetReviewKnowledgeSnapshot,
  summarize(_input, output) {
    return `knowledge snapshot · ${output.summary.total_knowledge} nodes · ${output.summary.due_count} due · ${output.summary.weak_count} weak`;
  },
  mirrorEvent: 'never',
};

// ───────────────────────────────────────────────────────────────────────────
// select_review_question_candidates — explainable candidate pool (CO §6:636-651).
// ───────────────────────────────────────────────────────────────────────────
//
// R6 / critic-R2 #4: routes THROUGH the public executeGetReviewDue path (NOT a
// raw query on the un-exported pickQuestionForKnowledge), so it auto-inherits
// the Guard-B invariant `draft_status != 'draft'`. GetReviewDueInputSchema has
// NO `constraints` arg (only {limit, knowledgeIds, causes, includeReason}); the
// shaping / ranking layer is built HERE on top of the shared tool — the shared
// tool input is NOT extended (R6).

const SelectCandidatesConstraintsSchema = z
  .object({
    limit: z.number().int().min(1).max(50).optional(),
    causes: z.array(z.string().min(1)).optional(),
    // Prefer never-reviewed failures first when true (default true — matches the
    // due queue's own ordering intent).
    prioritizeFailures: z.boolean().optional(),
  })
  .optional();

const SelectReviewQuestionCandidatesInputSchema = z.object({
  knowledgeIds: z.array(z.string().min(1)),
  constraints: SelectCandidatesConstraintsSchema,
});
type SelectReviewQuestionCandidatesInput = z.infer<
  typeof SelectReviewQuestionCandidatesInputSchema
>;

const ReviewCandidateSchema = z.object({
  question_id: z.string(),
  part_ref: z.string().nullable(),
  // review_profile / knowledge_coverage from question.metadata; the coverage
  // table is DEFER (CO §7.1:716-717) so these are best-effort passthrough.
  review_profile: z.unknown().nullable(),
  knowledge_coverage: z.array(z.string()),
  estimated_minutes: z.number().nullable(),
  memorization_risk: z.string().nullable(),
  confidence: z.number().nullable(),
  provenance: z.string(),
  why_candidate: z.string(),
  alternatives: z.array(z.string()),
  // YUK-226 S2-5a.1 — source/tier read model passthrough (derived in
  // get_review_due via deriveSourceTier). Used by the tier-preference ordering
  // below (authentic tier 1 preferred). Optional for back-compat with callers
  // that don't yet consume them.
  source: z.string().optional(),
  source_tier: z.number().int().min(1).max(4).optional(),
});

const SelectReviewQuestionCandidatesOutputSchema = z.object({
  candidates: z.array(ReviewCandidateSchema),
  pool_summary: z.object({
    total_returned: z.number().int(),
    never_reviewed_failure_count: z.number().int(),
    overdue_count: z.number().int(),
  }),
});
type SelectReviewQuestionCandidatesOutput = z.infer<
  typeof SelectReviewQuestionCandidatesOutputSchema
>;

async function executeSelectReviewQuestionCandidates(
  ctx: ToolContext,
  input: SelectReviewQuestionCandidatesInput,
): Promise<SelectReviewQuestionCandidatesOutput> {
  const constraints = input.constraints ?? {};
  const limit = constraints.limit ?? 20;
  // Route through the shared due path (inherits Guard-B draft filter). The
  // shared tool input is NOT extended — shaping happens below.
  const due = await executeGetReviewDue(ctx, {
    knowledgeIds: input.knowledgeIds,
    causes: constraints.causes,
    limit,
  });

  let neverFailure = 0;
  let overdue = 0;
  // OF-2 (plan §12) — side table for the within-tier-2 demotion sort below, kept
  // OUT of the ReviewCandidate output shape (whitelist_match is an internal sort
  // signal, not part of the candidate contract).
  const whitelistMatchByQid = new Map<string, boolean | null>();
  const candidates: SelectReviewQuestionCandidatesOutput['candidates'] = due.rows.map((row) => {
    const isFailure = row.reason === 'never_reviewed_failure';
    if (isFailure) neverFailure += 1;
    else overdue += 1;
    whitelistMatchByQid.set(row.question_id, row.whitelist_match);
    const why = isFailure
      ? `never-reviewed failure${row.latest_mistake?.cause ? ` (cause: ${row.latest_mistake.cause})` : ''}`
      : `overdue review${row.due_at ? ` (due ${row.due_at})` : ''}`;
    return {
      question_id: row.question_id,
      part_ref: null,
      review_profile: null,
      knowledge_coverage: row.knowledge_ids,
      estimated_minutes: null,
      memorization_risk: null,
      confidence: null,
      provenance: `review_due:${row.reason}`,
      why_candidate: why,
      alternatives: [],
      // YUK-226 S2-5a.1/5a.3 — source/tier passthrough for tier-preference order.
      source: row.source,
      source_tier: row.tier,
    };
  });

  // Shaping layer (R6): prioritise failures first when requested (default true).
  // YUK-226 S2-5a.3 — tier-preference ordering. Within the failure-first grouping,
  // prefer lower-numbered (higher) source tiers (1 authentic → 4 generated); and
  // within the same tier demote off-whitelist questions (whitelist_match === false
  // sorts behind true/null — OF-2, plan §12). Tier affects selection ORDER only,
  // never WHICH items are due nor WHEN (spec §7-3 invariant).
  const prioritizeFailures = constraints.prioritizeFailures ?? true;
  candidates.sort((a, b) => {
    if (prioritizeFailures) {
      const af = a.provenance.endsWith('never_reviewed_failure') ? 0 : 1;
      const bf = b.provenance.endsWith('never_reviewed_failure') ? 0 : 1;
      if (af !== bf) return af - bf;
    }
    // Shared §合约五 comparator: tier asc, then OF-2 within-tier demotion. Same
    // single comparator the sourcing-sequence existing-pool sort reuses.
    return compareBySourceTierThenWhitelist(
      {
        tier: a.source_tier ?? null,
        whitelistMatch: whitelistMatchByQid.get(a.question_id) ?? null,
      },
      {
        tier: b.source_tier ?? null,
        whitelistMatch: whitelistMatchByQid.get(b.question_id) ?? null,
      },
    );
  });

  return {
    candidates,
    pool_summary: {
      total_returned: candidates.length,
      never_reviewed_failure_count: neverFailure,
      overdue_count: overdue,
    },
  };
}

export const selectReviewQuestionCandidatesTool: DomainTool<
  SelectReviewQuestionCandidatesInput,
  SelectReviewQuestionCandidatesOutput
> = {
  name: 'select_review_question_candidates',
  description:
    'Select an explainable candidate question pool for the given knowledge_ids, routed through the deterministic review-due queue (draft questions excluded). Each candidate carries provenance + why_candidate. Read-only; never mutates FSRS / questions.',
  effect: 'read',
  inputSchema: SelectReviewQuestionCandidatesInputSchema,
  outputSchema: SelectReviewQuestionCandidatesOutputSchema,
  costClass: 'local',
  execute: executeSelectReviewQuestionCandidates,
  summarize(_input, output) {
    return `candidates · ${output.pool_summary.total_returned} · ${output.pool_summary.never_reviewed_failure_count} new · ${output.pool_summary.overdue_count} overdue`;
  },
  mirrorEvent: 'never',
};

// ───────────────────────────────────────────────────────────────────────────
// write_review_plan — persists the auditable plan as a tool_quiz artifact.
// ───────────────────────────────────────────────────────────────────────────
//
// U4/U5 boundary (plan §④-boundary): ToolStateT v2 (sections[] with
// per-assignment intent) is U5's owner. U4 writes the tool_quiz artifact using
// the EXISTING flat ToolState ({ question_ids, session_meta }) — question_ids
// from the assignment order + the full structured plan encoded in session_meta
// as a TRANSITION shape (promotable to v2 columns in U5 with no data loss).
// artifact.tool_kind is nullable free text → 'review_plan' needs no schema
// change. RED LINE: no new required ToolState Zod fields (U5 coordination).
//
// The contract is validated here: subject_ids = unique(sections[].subject_id),
// every assignment has primary_knowledge_id, guardrail_checks present.
// needs[] rides on the plan output (CO §6.1:700-704), not as a side effect.

const ReviewPlanAssignmentSchema = z.object({
  question_id: z.string().min(1),
  // Round-4 REJECT (CR 3359642325 + 3359720370) — part_ref semantics + judge narrowing.
  //
  // part_ref is ALWAYS a StructuredQuestion.id (an embedded JSON node id inside the
  // parent question's sub_questions tree; CO §2.2 / design spec line 167). It is NOT
  // a kind='question_part' row id (that is the T-QP/YUK-165 axis, a separate feature
  // using the parent_question_id FK in the question table).
  //
  // CR 3359720370 asks whether the judge should narrow to the sub-question node's
  // prompt_text/answers (from question.structured) instead of the parent's full
  // prompt_md/reference_md. Investigation result: the /api/review/submit single-question
  // flow also passes the full parent question row to the invoker without sub-question
  // narrowing — this is platform-consistent behavior on both paths. The sub-question
  // content IS included in the parent's prompt_md (rendered via structuredToPromptMarkdown
  // on import). REJECT-as-platform-consistent; tracked in Linear for future improvement
  // when sub-question-level FSRS keying is implemented (see judge invoker.ts).
  part_ref: z.string().optional(),
  primary_knowledge_id: z.string().min(1),
  secondary_knowledge_ids: z.array(z.string()).default([]),
  review_profile_snapshot: z.unknown().optional(),
  coverage_snapshot: z.unknown().optional(),
  selection_reason: z.string().optional(),
});

const ReviewPlanSectionSchema = z.object({
  subject_id: z.string().min(1),
  knowledge_ids: z.array(z.string()).default([]),
  assignments: z.array(ReviewPlanAssignmentSchema),
  feedback_policy: z.unknown().optional(),
  adaptation_policy: z.unknown().optional(),
});

const ReviewPlanNeedSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('question_profile_refresh'),
    question_id: z.string().min(1),
    reason: z.string().min(1),
  }),
  z.object({
    kind: z.literal('question_generation'),
    knowledge_id: z.string().min(1),
    reason: z.string().min(1),
  }),
]);

const ReviewPlanContractSchema = z.object({
  subject_ids: z.array(z.string().min(1)),
  labels: z.object({
    paper_kind: z.string().optional(),
    time_box: z.number().int().nonnegative().optional(),
    intent_tags: z.array(z.string()).default([]),
    subject_mix: z.unknown().optional(),
    adaptation_level: z.string().optional(),
    difficulty_shape: z.string().optional(),
    source: z.string().optional(),
  }),
  rationale: z.string().optional(),
  sections: z.array(ReviewPlanSectionSchema),
  guardrail_checks: z.object({
    within_time_budget: z.boolean(),
    candidate_pool_only: z.boolean(),
    every_assignment_has_primary_knowledge: z.boolean(),
    no_direct_scheduler_mutation: z.boolean(),
  }),
  needs: z.array(ReviewPlanNeedSchema).default([]),
});
export type ReviewPlanContractT = z.infer<typeof ReviewPlanContractSchema>;

// U5 (YUK-203, §4.8) — map a U4 ReviewPlan section onto the promoted ToolStateT
// v2 `ToolStateSection` shape so the artifact carries top-level `sections[]`
// going forward (with the session_meta copy retained for the transition
// window). feedback_policy / adaptation_policy are free strings at the v2 schema
// layer: U4 currently emits no value, so the default 'immediate' keeps every
// current paper immediately-visible (back-compat safe — only the sentinel
// 'judge_now_show_later' hides feedback, mapped in the paper submit handler).
function toToolStateSections(plan: ReviewPlanContractT): ToolStateSectionT[] {
  return plan.sections.map((section) => ({
    knowledge_focus: section.knowledge_ids,
    feedback_policy:
      typeof section.feedback_policy === 'string' ? section.feedback_policy : 'immediate',
    adaptation_policy:
      typeof section.adaptation_policy === 'string' ? section.adaptation_policy : 'none',
    assignments: section.assignments.map((a) => ({
      question_id: a.question_id,
      ...(a.part_ref !== undefined ? { part_ref: a.part_ref } : {}),
      primary_knowledge_id: a.primary_knowledge_id,
      secondary_knowledge_ids: a.secondary_knowledge_ids,
      selection_reason: a.selection_reason ?? '',
      review_profile_snapshot:
        a.review_profile_snapshot && typeof a.review_profile_snapshot === 'object'
          ? (a.review_profile_snapshot as Record<string, unknown>)
          : {},
    })),
  }));
}

const WriteReviewPlanInputSchema = z.object({
  plan: ReviewPlanContractSchema,
  // initial_plan (nightly/on-demand) vs checkpoint_adapt (in-session). Recorded
  // on the artifact session_meta for traceability.
  mode: z.enum(['initial_plan', 'checkpoint_adapt']).default('initial_plan'),
});
// z.input: .default() on mode + the contract's defaulted arrays make input the
// assignable type for the DomainTool inputSchema generic (see ReadCoachBrief).
type WriteReviewPlanInput = z.input<typeof WriteReviewPlanInputSchema>;

const WriteReviewPlanOutputSchema = z.object({
  artifact_id: z.string(),
  question_count: z.number().int(),
  subject_ids: z.array(z.string()),
  needs: z.array(ReviewPlanNeedSchema),
});
type WriteReviewPlanOutput = z.infer<typeof WriteReviewPlanOutputSchema>;

function validateReviewPlanContract(plan: ReviewPlanContractT): void {
  // Invariant (CO §7.1:775): subject_ids = unique(sections[].subject_id).
  const sectionSubjects = [...new Set(plan.sections.map((s) => s.subject_id))].sort();
  const declared = [...new Set(plan.subject_ids)].sort();
  if (
    sectionSubjects.length !== declared.length ||
    sectionSubjects.some((s, i) => s !== declared[i])
  ) {
    throw new Error(
      `write_review_plan: subject_ids invariant violated — subject_ids must equal unique(sections[].subject_id). got=[${declared.join(',')}] sections=[${sectionSubjects.join(',')}]`,
    );
  }
  // Every assignment has a primary_knowledge_id (Zod min(1) already enforces
  // non-empty; this surfaces a clear contract message + sets the guardrail).
  for (const section of plan.sections) {
    for (const a of section.assignments) {
      if (!a.primary_knowledge_id) {
        throw new Error(
          `write_review_plan: assignment ${a.question_id} missing primary_knowledge_id`,
        );
      }
    }
  }
  if (!plan.guardrail_checks.every_assignment_has_primary_knowledge) {
    throw new Error(
      'write_review_plan: guardrail_checks.every_assignment_has_primary_knowledge must be true',
    );
  }
  // codex PR #298 #3357817933 — reject any self-reported FALSE guardrail.
  // The planner attests to four hard constraints; an honestly-flagged
  // violation (e.g. candidate_pool_only=false, within_time_budget=false,
  // no_direct_scheduler_mutation=false) must NOT persist a `ready` paper that
  // the user would then execute. Same treatment as
  // every_assignment_has_primary_knowledge above; list every failed check so
  // the failure is auditable.
  const failedGuardrails = Object.entries(plan.guardrail_checks)
    .filter(([, value]) => value === false)
    .map(([key]) => key);
  if (failedGuardrails.length > 0) {
    throw new Error(
      `write_review_plan: guardrail_checks must all be true — failed: [${failedGuardrails.join(',')}]`,
    );
  }
}

// Existence + non-draft backstop for the planner-supplied question_ids
// (codex-review #3357652733). Throws with a message listing the offending ids
// so the failure is auditable (and, in the boss handler, fails the job so it
// retries rather than persisting an unrunnable ready paper). Returns each
// question's knowledge_ids so the caller can validate assignment knowledge-
// point coverage (codex PR #298 #3357817923).
async function assertQuestionsExistAndRunnable(
  ctx: ToolContext,
  questionIds: string[],
): Promise<Map<string, string[]>> {
  const wanted = [...new Set(questionIds)];
  if (wanted.length === 0) return new Map();
  const rows = await ctx.db
    .select({
      id: question.id,
      draft_status: question.draft_status,
      knowledge_ids: question.knowledge_ids,
    })
    .from(question)
    .where(inArray(question.id, wanted));
  const found = new Map(rows.map((r) => [r.id, r.draft_status]));

  const missing = wanted.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new Error(
      `write_review_plan: assignment question_id(s) do not exist: [${missing.join(',')}]`,
    );
  }
  const drafts = wanted.filter((id) => found.get(id) === 'draft');
  if (drafts.length > 0) {
    throw new Error(
      `write_review_plan: assignment question_id(s) are draft (unrunnable): [${drafts.join(',')}]`,
    );
  }
  return new Map(rows.map((r) => [r.id, r.knowledge_ids ?? []]));
}

// codex PR #298 #3357817923 — reject assignment knowledge points that are NOT
// in the assigned question's own knowledge_ids.
//
// CONTRAST with #295 submit-judge (which INTERSECTS rather than rejects): the
// judge writes against *evidence* semantics, where an out-of-scope id is just
// outside the proven coverage and is safely dropped to the intersection. The
// planner here is asserting *coverage facts* used to mount the paper onto
// knowledge nodes (by-knowledge entry + backlinks); an assignment knowledge id
// that the question does not actually cover is a planner hallucination, not a
// narrowing — silently intersecting would hide the bug AND could leave an
// assignment with no primary knowledge. So we REJECT (list the violating
// pairs) rather than intersect.
function assertAssignmentKnowledgeWithinCoverage(
  plan: ReviewPlanContractT,
  knowledgeIdsByQuestion: Map<string, string[]>,
): void {
  const violations: string[] = [];
  for (const section of plan.sections) {
    for (const a of section.assignments) {
      const coverage = new Set(knowledgeIdsByQuestion.get(a.question_id) ?? []);
      const assigned = [a.primary_knowledge_id, ...a.secondary_knowledge_ids];
      for (const kid of assigned) {
        if (!coverage.has(kid)) violations.push(`${a.question_id}→${kid}`);
      }
    }
  }
  if (violations.length > 0) {
    throw new Error(
      `write_review_plan: assignment knowledge_id(s) not in the question's knowledge_ids coverage: [${violations.join(',')}]`,
    );
  }
}

async function executeWriteReviewPlan(
  ctx: ToolContext,
  rawInput: WriteReviewPlanInput,
): Promise<WriteReviewPlanOutput> {
  // Re-parse to resolve .default()s (mode, the contract's defaulted arrays) —
  // mirrors executeGetReviewDue's parse-inside-execute pattern. The bridge
  // already parses, but this keeps the function callable directly + typed.
  const { plan, mode } = WriteReviewPlanInputSchema.parse(rawInput);
  validateReviewPlanContract(plan);

  const questionIds = plan.sections.flatMap((s) => s.assignments.map((a) => a.question_id));
  const subjectIds = [...new Set(plan.subject_ids)];

  // codex PR #298 #3357817927 — reject an empty paper. A plan with no
  // assignments (sections:[] or every section's assignments:[]) yields
  // questionIds.length===0 and would otherwise persist a `ready` tool_quiz
  // with no tool_state.question_ids — an unexecutable empty paper. When the
  // candidate pool is insufficient the planner must NOT write a paper; it
  // should only declare needs[] (question_generation / question_profile_refresh)
  // and let the run finish without an artifact.
  // TRADEOFF (paired with the boss handler's 0-artifact failure path,
  // review_plan.ts): on a pool-empty night this throw → the run writes 0
  // artifacts → the handler fails the job (with finishReason/needs summary) →
  // pg-boss bounded retry. "Every night yields a paper" is NOT an invariant;
  // the pool-gap signal reaches the Coach via the U3 agent_note channel.
  if (questionIds.length === 0) {
    throw new Error(
      'write_review_plan: refusing to write an empty review paper — no assignments. When the candidate pool is insufficient, declare needs[] (question_generation / question_profile_refresh) and do NOT write a plan.',
    );
  }

  // codex PR #298 #3357961871 — reject duplicate question_ids across
  // assignments. Two assignments pointing at the same question would persist a
  // paper whose tool_state.question_ids carries the same id twice (a duplicate
  // item in one review session). We REJECT (list the duplicated ids) rather
  // than silently de-dup: a duplicate is a planner mistake worth surfacing for
  // audit, and silent de-dup would hide it (consistent with this PR's
  // reject-over-silently-narrow philosophy — see assertAssignment* below).
  const seenQuestionIds = new Set<string>();
  const duplicateQuestionIds = new Set<string>();
  for (const id of questionIds) {
    if (seenQuestionIds.has(id)) duplicateQuestionIds.add(id);
    else seenQuestionIds.add(id);
  }
  if (duplicateQuestionIds.size > 0) {
    throw new Error(
      `write_review_plan: duplicate assignment question_id(s) across sections: [${[...duplicateQuestionIds].join(',')}]`,
    );
  }

  // Validate the planned question IDs against `question` BEFORE persisting
  // (codex-review #3357652733). The planner is an LLM; a hallucinated id or a
  // draft question would otherwise produce a `ready` review paper that the
  // session can't execute. Three invariants are HARD-enforced here:
  //   - existence: every assignment question_id must resolve to a real row;
  //   - non-draft: Guard-B (`draft_status='draft'` is unrunnable in review);
  //   - knowledge coverage (#3357817923): every assignment knowledge id must be
  //     in that question's own knowledge_ids (REJECT, not intersect — see
  //     assertAssignmentKnowledgeWithinCoverage for the #295 contrast).
  // candidate-pool membership is NOT re-checkable here: the candidate pool
  // lives in `select_review_question_candidates`'s output, not in this tool's
  // input. So `guardrail_checks.candidate_pool_only` is the planner's own
  // self-attestation that it only assigned pool-sourced questions; existence +
  // non-draft + coverage are the backstop this tool can prove against the DB.
  const knowledgeIdsByQuestion = await assertQuestionsExistAndRunnable(ctx, questionIds);
  assertAssignmentKnowledgeWithinCoverage(plan, knowledgeIdsByQuestion);

  // Derive artifact knowledge_ids ONLY from the VALIDATED assignment primary +
  // secondary knowledge ids (codex-review #3357652748 + #3357932409). These are
  // the only ids assertAssignmentKnowledgeWithinCoverage proved are real
  // question coverage; section.knowledge_ids is NOT validated against the DB, so
  // folding it into the artifact's knowledge_ids could mount the paper onto a
  // hallucinated / mistyped node (breaking by-knowledge entry + backlinks). We
  // also REQUIRE section.knowledge_ids ⊆ this derived set and REJECT any
  // section-level id outside it (list the violating ids) — reject over silently
  // dropping, consistent with assertAssignmentKnowledgeWithinCoverage / the dup
  // check above: a stray section id is a planner mistake worth surfacing.
  const assignmentKnowledgeIds = new Set<string>(
    plan.sections.flatMap((s) =>
      s.assignments.flatMap((a) => [a.primary_knowledge_id, ...a.secondary_knowledge_ids]),
    ),
  );
  const sectionKnowledgeViolations: string[] = [];
  for (const section of plan.sections) {
    for (const kid of section.knowledge_ids) {
      if (!assignmentKnowledgeIds.has(kid)) {
        sectionKnowledgeViolations.push(`${section.subject_id}→${kid}`);
      }
    }
  }
  if (sectionKnowledgeViolations.length > 0) {
    throw new Error(
      `write_review_plan: section knowledge_id(s) not covered by any assignment's primary/secondary knowledge: [${sectionKnowledgeViolations.join(',')}]`,
    );
  }
  const knowledgeIds = [...assignmentKnowledgeIds];
  const now = new Date();
  const artifactId = `review_plan_${createId()}`;

  // codex PR #298 #3357817915 + #3357918622 — idempotency guard against
  // multiple papers per run. If the model calls write_review_plan twice within
  // the SAME ReviewPlanTask run, the second call would persist a duplicate
  // `ready` paper; there is no downstream de-dup/selection, so the user would
  // get two review papers from one nightly run. We refuse the second write
  // here, keyed on ctx.taskRunId (== tool_context_task_run_id stamped into
  // session_meta). The handler's post-run count check is tightened to
  // "exactly 1" as a second layer.
  //
  // TOCTOU (#3357918622): a bare select-then-insert lets two concurrent calls
  // with the same taskRunId both pass the existence check and both insert. We
  // close the race the SAME way as the proposal-signal writers (ADR-0028
  // submit route precedent — withProposalSignalLock in
  // src/server/proposals/signals.ts:25): wrap check + insert in ONE
  // transaction and take a `pg_advisory_xact_lock` keyed on the run, so a
  // concurrent caller blocks until we commit and then sees the existing row.
  // The lock auto-releases at txn boundary. We deliberately do NOT add a UNIQUE
  // index — that needs a migration, and U4 is a zero-schema-change phase
  // (D3 §4-① RED LINE: no DDL); the advisory lock gives the same mutual
  // exclusion without touching the schema.
  await ctx.db.transaction(async (tx) => {
    if (ctx.taskRunId) {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`review_plan:${ctx.taskRunId}`}, 0))`,
      );
      const [existing] = await tx
        .select({ id: artifact.id })
        .from(artifact)
        .where(
          and(
            eq(artifact.tool_kind, 'review_plan'),
            sql`${artifact.tool_state}->'session_meta'->>'tool_context_task_run_id' = ${ctx.taskRunId}`,
          ),
        )
        .limit(1);
      if (existing) {
        throw new Error(
          `write_review_plan: a review plan already exists for this run (tool_context_task_run_id=${ctx.taskRunId}, artifact=${existing.id}) — only one plan may be written per run`,
        );
      }
    }

    // U5 (YUK-203, §4.3/§4.8) — ToolStateT v2: promote `sections[]` to the TOP
    // level of tool_state (parsed through the ToolState Zod barrier — jsonb is
    // opaque to audit:schema, so the barrier is the load-bearing guard, RL4),
    // while RETAINING the session_meta copy for the U4-era read shim
    // (readPaperSections). No data loss; the U4 guarantee held.
    const toolState = ToolState.parse({
      question_ids: questionIds,
      sections: toToolStateSections(plan),
      session_meta: {
        mode,
        subject_ids: subjectIds,
        labels: plan.labels,
        rationale: plan.rationale,
        sections: plan.sections,
        guardrail_checks: plan.guardrail_checks,
        needs: plan.needs,
        tool_context_task_run_id: ctx.taskRunId,
      },
    });
    await tx.insert(artifact).values({
      id: artifactId,
      type: 'tool_quiz',
      title: plan.labels.paper_kind ? `复习卷 · ${plan.labels.paper_kind}` : '复习卷',
      parent_artifact_id: null,
      knowledge_ids: knowledgeIds,
      intent_source: 'review_plan',
      source: 'ai_generated',
      source_ref: null,
      body_blocks: null,
      attrs: {
        mode,
        subject_ids: subjectIds,
        intent_tags: plan.labels.intent_tags,
      } as never,
      tool_kind: 'review_plan',
      tool_state: toolState as never,
      generation_status: 'ready',
      verification_status: 'not_required',
      history: [],
      created_at: now,
      updated_at: now,
      version: 0,
    });
  });

  return {
    artifact_id: artifactId,
    question_count: questionIds.length,
    subject_ids: subjectIds,
    needs: plan.needs,
  };
}

export const writeReviewPlanTool: DomainTool<WriteReviewPlanInput, WriteReviewPlanOutput> = {
  name: 'write_review_plan',
  description:
    "Persist the auditable review_plan as a tool_quiz paper artifact. Validates the contract: subject_ids = unique(sections[].subject_id), every assignment has primary_knowledge_id, guardrail_checks present. The full structured plan is encoded in the artifact session_meta. needs[] (question_profile_refresh / question_generation) rides on the output. This is the planner's ONLY write — it does NOT touch FSRS / due / question metadata / judge events.",
  effect: 'write',
  inputSchema: WriteReviewPlanInputSchema,
  outputSchema: WriteReviewPlanOutputSchema,
  costClass: 'local',
  execute: executeWriteReviewPlan,
  summarize(_input, output) {
    return `review plan · ${output.question_count} questions · subjects=${output.subject_ids.length} · needs=${output.needs.length}`;
  },
  mirrorEvent: 'never',
};
