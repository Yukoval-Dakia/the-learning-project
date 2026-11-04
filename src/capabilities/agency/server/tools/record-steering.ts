// YUK-1770 record_steering — the companion's direct steering write (D3).
//
// The ONLY hard deterministic gate is verbatim integrity: `learner_words` must
// appear (NFKC, whitespace-collapsed) in a message the learner actually sent in
// the capturing copilot session. Everything else degrades to typed issues:
// unknown KC ids drop to `scope_unresolved` text, an unknown subject becomes an
// issue, and the write still lands — the learner's instruction is a fact the
// moment they said it, not a proposal. The confirmation sentence the companion
// reads back is built ONLY from this tool's result (「记下了…接下来我会…」).

import { and, desc, eq, inArray, lte } from 'drizzle-orm';
import { z } from 'zod';
import { isLearnerLocalDay, learnerLocalDay } from '@/core/learner-day';
import { SteeringGoalData, type SteeringGoalDataT } from '@/core/schema/steering';
import { learnerDayWeekday, quoteAppearsInMessage, steeringDaysLeft } from '@/core/steering';
import { goal, knowledge, material_fsrs_state } from '@/db/schema';
import { ApiError } from '@/kernel/http';
import { listActiveSteeringGoals } from '@/kernel/read-models/active-goal-scope';
import { getNonKcKnowledgeIds } from '@/kernel/read-models/knowledge-roles';
import { resolveSubjectKnowledgeIds } from '@/kernel/read-models/knowledge-tree';
import {
  createLearnerSteering,
  updateGoalScope,
  updateGoalStatus,
} from '@/kernel/records/goal-commands';
import type { DomainTool, ToolContext } from '@/kernel/tools/types';
import { normalizeSubjectKey, resolveKnownSubjectId } from '@/subjects/profile';

const LearnerLocalDay = z
  .string()
  .refine(isLearnerLocalDay, 'must be a learner-local YYYY-MM-DD calendar day');

// Object-root on purpose (audit:tool-params): a discriminated union compiles to
// an anyOf root, which the wire rejects. `op` + optional per-op fields instead.
const RecordSteeringInputSchema = z.object({
  op: z.enum(['create', 'revise', 'end']),
  /** The goal being revised/ended. Optional when exactly ONE steering goal is
   *  active (the common follow-up case: the confirmation text carries no id);
   * required when several are active. */
  goal_id: z.string().min(1).optional(),
  /** Verbatim quote from the learner's message this turn (≤500 chars). */
  learner_words: z.string().min(1).max(500),
  /** Plain restatement of the instruction; the guidance-facing summary. */
  instruction_md: z.string().min(1).max(280).optional(),
  subject_id: z.string().min(1).max(80).optional(),
  window: z
    .object({
      from: LearnerLocalDay.nullable(),
      until: LearnerLocalDay.nullable(),
    })
    .optional(),
  scope: z
    .object({
      text: z.string().max(200).nullable().optional(),
      knowledge_ids: z.array(z.string().min(1)).max(60).optional(),
      unresolved: z.array(z.string().max(80)).max(10).optional(),
    })
    .optional(),
  /** D4 subtractive steering (「这周别排物理」). */
  exclude: z
    .object({
      subject_ids: z.array(z.string().min(1).max(80)).max(8).optional(),
      knowledge_ids: z.array(z.string().min(1)).max(60).optional(),
    })
    .optional(),
  metadata: z
    .record(z.string().max(40), z.union([z.string().max(200), z.number(), z.boolean()]))
    .optional(),
  /** end only: why it ended (withdrawal). */
  reason_md: z.string().max(280).optional(),
});

const SteeringIssueSchema = z.object({
  kind: z.enum([
    'scope_id_unknown',
    'scope_id_not_testable',
    'subject_unknown',
    'exclude_id_unknown',
    'exclude_subject_unknown',
    'already_inactive',
  ]),
  detail: z.string().max(200),
});

const RecordSteeringOutputSchema = z.object({
  status: z.enum(['created', 'revised', 'ended', 'unchanged']),
  goal_id: z.string(),
  issues: z.array(SteeringIssueSchema),
  echo: z.object({
    instruction_md: z.string(),
    window: z.object({
      from: z.string().nullable(),
      until: z.string().nullable(),
      until_weekday: z.string().nullable(),
      days_left: z.number().int().nullable(),
    }),
    scope: z.object({
      resolved_knowledge_ids: z.array(z.string()),
      unresolved: z.array(z.string()),
    }),
    excluded_subject_ids: z.array(z.string()),
    excluded_knowledge_ids: z.array(z.string()),
  }),
  /** The downstream work this change triggers; the ONLY commitments the
   * confirmation sentence may make. */
  preparing: z.array(
    z.enum(['companion_context', 'today_plan', 'question_supply', 'review_notes']),
  ),
  /** D4: due review items deferred inside the window (kept, not deleted). */
  deferred_due_reviews: z.number().int().nullable(),
});

type RecordSteeringToolInput = z.input<typeof RecordSteeringInputSchema>;
type RecordSteeringToolOutput = z.infer<typeof RecordSteeringOutputSchema>;

const ASK_ACTIONS = ['experimental:copilot_user_ask', 'experimental:copilot_chip_trigger'] as const;

// Fixed work set per design §2.2: the same-day effects of any steering change.
const PREPARING = ['companion_context', 'today_plan', 'question_supply'] as const;

/** Idempotency: normalized (instruction, window, scope, exclusion) signature. */
function normalizedSignature(
  instruction: string,
  s: {
    effective_from: string | null;
    effective_until: string | null;
    steering: SteeringGoalDataT;
  },
): string {
  const st = s.steering;
  return JSON.stringify([
    instruction,
    s.effective_from,
    s.effective_until,
    st.scope_text,
    [...st.scope_unresolved].sort(),
    [...st.excluded_subject_ids].sort(),
    [...st.excluded_knowledge_ids].sort(),
  ]);
}

async function readRecentUserMessages(ctx: ToolContext, limit = 20): Promise<string[]> {
  const { event } = await import('@/db/schema');
  const rows = await ctx.db
    .select({ payload: event.payload })
    .from(event)
    .where(and(eq(event.session_id, ctx.sessionId ?? ''), inArray(event.action, [...ASK_ACTIONS])))
    .orderBy(desc(event.created_at))
    .limit(limit);
  return rows
    .map((row) => (row.payload as { user_message?: unknown }).user_message)
    .filter((msg): msg is string => typeof msg === 'string');
}

/** Resolve live KC ids; unknown and non-kc ids drop out with a typed issue each. */
async function resolveScopeKnowledgeIds(
  ctx: ToolContext,
  ids: string[],
  issues: RecordSteeringToolOutput['issues'],
): Promise<string[]> {
  if (ids.length === 0) return [];
  const distinct = [...new Set(ids)];
  const rows = await ctx.db
    .select({ id: knowledge.id, role: knowledge.role })
    .from(knowledge)
    .where(inArray(knowledge.id, distinct));
  const liveById = new Map(rows.map((row) => [row.id, row.role]));
  const nonKc = await getNonKcKnowledgeIds(ctx.db, distinct);
  const resolved: string[] = [];
  for (const id of distinct) {
    const role = liveById.get(id);
    if (role === undefined) {
      issues.push({ kind: 'scope_id_unknown', detail: id });
    } else if (nonKc.has(id)) {
      issues.push({ kind: 'scope_id_not_testable', detail: id });
    } else {
      resolved.push(id);
    }
  }
  return resolved;
}

/** Canonicalize subject ids; unknown ones issue and drop. */
function resolveSubjectIds(
  raw: string[],
  issues: RecordSteeringToolOutput['issues'],
  issueKind: 'subject_unknown' | 'exclude_subject_unknown',
): string[] {
  const out: string[] = [];
  for (const id of raw) {
    const canonical = resolveKnownSubjectId(id) ?? (normalizeSubjectKey(id) ? id : null);
    if (canonical === null) {
      issues.push({ kind: issueKind, detail: id });
    } else if (!out.includes(canonical)) {
      out.push(canonical);
    }
  }
  return out;
}

/** D4 cost statement input: KC-level items due now that the window defers. */
async function countDeferredDueReviews(
  ctx: ToolContext,
  excluded: Set<string>,
  now: Date,
): Promise<number | null> {
  if (excluded.size === 0) return null;
  const rows = await ctx.db
    .select({ subject_id: material_fsrs_state.subject_id })
    .from(material_fsrs_state)
    .where(
      and(
        eq(material_fsrs_state.subject_kind, 'knowledge'),
        lte(material_fsrs_state.due_at, now),
        inArray(material_fsrs_state.subject_id, [...excluded]),
      ),
    );
  return rows.length;
}

/**
 * goal_id resolution for revise/end: an explicit id wins; otherwise the single
 * active steering goal (follow-up turns cannot carry the id — conversation
 * history keeps prose only). Ambiguity fails loudly instead of guessing.
 */
async function resolveSingleSteeringGoalId(
  ctx: ToolContext,
  explicit: string | undefined,
): Promise<string> {
  if (explicit) return explicit;
  const active = await listActiveSteeringGoals(ctx.db);
  if (active.length === 1) return active[0].id;
  if (active.length === 0) {
    throw new ApiError('not_found', 'no active steering goal to revise or end', 404);
  }
  throw new ApiError(
    'validation_error',
    `several steering goals are active; pass one of: ${active.map((g) => g.id).join(', ')}`,
    400,
  );
}

async function buildExcludedSet(
  ctx: ToolContext,
  excludedSubjects: string[],
  excludedKnowledgeIds: string[],
): Promise<Set<string>> {
  const set = new Set<string>(excludedKnowledgeIds);
  for (const subjectId of excludedSubjects) {
    for (const kc of await resolveSubjectKnowledgeIds(ctx.db, subjectId)) set.add(kc);
  }
  return set;
}

export const recordSteeringTool: DomainTool<RecordSteeringToolInput, RecordSteeringToolOutput> = {
  name: 'record_steering',
  description:
    "MUST be called FIRST — before any advice or proposal — whenever the learner states an exam/quiz date or scope (期中/期末/测验), a study deadline, a priority change (这周主攻/别排物理), or cancels a prior arrangement (考试取消了). Writes directly, no proposal: learner_words MUST quote the learner's words verbatim from the current message (server-checked; paraphrases are rejected); unmappable scope stays as text. Build the confirmation ONLY from the result's echo/issues/preparing. Never substitute a knowledge-tree proposal or a spoken-only recap for this call.",
  effect: 'write',
  inputSchema: RecordSteeringInputSchema,
  outputSchema: RecordSteeringOutputSchema,
  costClass: 'local',
  mirrorEvent: 'when_causal',
  async execute(ctx, input) {
    if (
      ctx.callerActor.kind !== 'agent' ||
      !['agent:copilot', 'agent:copilot_chip'].includes(ctx.callerActor.ref)
    ) {
      throw new ApiError('forbidden', 'record_steering is restricted to the companion', 403);
    }

    const issues: RecordSteeringToolOutput['issues'] = [];
    const now = new Date();
    const today = learnerLocalDay(now);

    // ── hard gate: the quote must come from this session's real messages ──
    const messages = await readRecentUserMessages(ctx);
    if (!messages.some((message) => quoteAppearsInMessage(input.learner_words, message))) {
      throw new ApiError(
        'validation_error',
        'learner_words 不在学习者本轮消息里：必须逐字引用学习者原话，不能转述',
        422,
      );
    }

    if (input.op === 'end') {
      const goalId = await resolveSingleSteeringGoalId(ctx, input.goal_id);
      const [row] = await ctx.db
        .select({ id: goal.id, status: goal.status, steering: goal.steering })
        .from(goal)
        .where(eq(goal.id, goalId))
        .limit(1);
      if (!row || row.steering === null) {
        throw new ApiError('not_found', 'unknown steering goal', 404);
      }
      if (row.status === 'active') {
        await updateGoalStatus(
          ctx.db,
          row.id,
          'dormant',
          now,
          { reason_md: input.reason_md, learner_words: input.learner_words, ended_by: 'learner' },
          'steering-end',
        );
      } else {
        issues.push({ kind: 'already_inactive', detail: `status=${row.status}` });
      }
      const steering = row.steering;
      return {
        status: 'ended',
        goal_id: row.id,
        issues,
        echo: {
          instruction_md: steering.instruction_md,
          window: { from: null, until: null, until_weekday: null, days_left: null },
          scope: { resolved_knowledge_ids: [], unresolved: [] },
          excluded_subject_ids: [...steering.excluded_subject_ids],
          excluded_knowledge_ids: [...steering.excluded_knowledge_ids],
        },
        preparing: [...PREPARING],
        deferred_due_reviews: null,
      };
    }

    // create / revise share the payload build
    if (input.op === 'revise' && !input.goal_id) {
      throw new ApiError('validation_error', 'revise requires goal_id', 400);
    }
    if (!input.instruction_md) {
      throw new ApiError('validation_error', `${input.op} requires instruction_md`, 400);
    }
    // Window: default from=today; reject inverted ranges. create rejects a past until.
    const from = input.window?.from ?? today;
    const until = input.window?.until ?? null;
    if (from !== null && !isLearnerLocalDay(from)) {
      throw new ApiError('validation_error', 'window.from must be YYYY-MM-DD', 400);
    }
    if (until !== null && !isLearnerLocalDay(until)) {
      throw new ApiError('validation_error', 'window.until must be YYYY-MM-DD', 400);
    }
    if (from !== null && until !== null && from > until) {
      throw new ApiError('validation_error', 'window: from must not be after until', 400);
    }
    if (input.op === 'create' && until !== null && until < today) {
      throw new ApiError('validation_error', 'window.until 已在过去；到期指令请直接 end', 400);
    }

    const subjectId = input.subject_id
      ? (resolveSubjectIds([input.subject_id], issues, 'subject_unknown')[0] ?? null)
      : null;

    const requestedIds = input.scope?.knowledge_ids ?? [];
    const resolvedIds = await resolveScopeKnowledgeIds(ctx, requestedIds, issues);
    const unresolved = [...(input.scope?.unresolved ?? [])];
    const scopeText = input.scope?.text ?? null;

    const excludedSubjects = resolveSubjectIds(
      input.exclude?.subject_ids ?? [],
      issues,
      'exclude_subject_unknown',
    );
    const excludedKnowledgeIds = await (async () => {
      const raw = input.exclude?.knowledge_ids ?? [];
      if (raw.length === 0) return [];
      const rows = await ctx.db
        .select({ id: knowledge.id })
        .from(knowledge)
        .where(inArray(knowledge.id, [...new Set(raw)]));
      const live = new Set(rows.map((row) => row.id));
      return [...new Set(raw)].filter((id) => {
        if (live.has(id)) return true;
        issues.push({ kind: 'exclude_id_unknown', detail: id });
        return false;
      });
    })();

    const steering: SteeringGoalDataT = SteeringGoalData.parse({
      learner_words: input.learner_words,
      instruction_md: input.instruction_md,
      scope_text: scopeText,
      scope_unresolved: unresolved,
      excluded_subject_ids: excludedSubjects,
      excluded_knowledge_ids: excludedKnowledgeIds,
      metadata: input.metadata ?? {},
    });

    if (input.op === 'create') {
      // Idempotency: identical words + identical normalized content → unchanged.
      const signature = normalizedSignature(input.instruction_md, {
        effective_from: from,
        effective_until: until,
        steering,
      });
      for (const active of (await listActiveSteeringGoals(ctx.db)).filter(
        (g): g is typeof g & { steering: SteeringGoalDataT } => g.steering !== null,
      )) {
        if (
          active.steering.learner_words === input.learner_words &&
          normalizedSignature(active.steering.instruction_md, active) === signature
        ) {
          return {
            status: 'unchanged',
            goal_id: active.id,
            issues,
            echo: echoOf(active, today, active.scope_knowledge_ids),
            preparing: [],
            deferred_due_reviews: null,
          };
        }
      }
      const goalId = await createLearnerSteering(ctx.db, {
        title: input.instruction_md.slice(0, 120),
        subject_id: subjectId,
        scope_knowledge_ids: resolvedIds,
        sequence_hint: 0,
        effective_from: from,
        effective_until: until,
        steering,
        source_ref: ctx.causedByEventId ?? ctx.taskRunId,
        now,
      });
      const deferred = await countDeferredDueReviews(
        ctx,
        await buildExcludedSet(ctx, excludedSubjects, excludedKnowledgeIds),
        now,
      );
      return {
        status: 'created',
        goal_id: goalId,
        issues,
        echo: echoOf(
          { effective_from: from, effective_until: until, steering },
          today,
          resolvedIds,
        ),
        preparing: [...PREPARING],
        deferred_due_reviews: deferred,
      };
    }

    // revise
    const reviseGoalId = await resolveSingleSteeringGoalId(ctx, input.goal_id);
    const [row] = await ctx.db
      .select({ id: goal.id, steering: goal.steering })
      .from(goal)
      .where(eq(goal.id, reviseGoalId))
      .limit(1);
    if (!row || row.steering === null) {
      throw new ApiError('not_found', 'unknown steering goal', 404);
    }
    await updateGoalScope(
      ctx.db,
      row.id,
      {
        title: input.instruction_md.slice(0, 120),
        scope_knowledge_ids: resolvedIds,
        effective_from: from,
        effective_until: until,
        steering,
      },
      now,
      'steering-revise',
    );
    const deferred = await countDeferredDueReviews(
      ctx,
      await buildExcludedSet(ctx, excludedSubjects, excludedKnowledgeIds),
      now,
    );
    return {
      status: 'revised',
      goal_id: row.id,
      issues,
      echo: echoOf({ effective_from: from, effective_until: until, steering }, today, resolvedIds),
      preparing: [...PREPARING],
      deferred_due_reviews: deferred,
    };
  },
  summarize(input, output) {
    return `steering ${input.op} → ${output.status}${output.deferred_due_reviews ? ` · defer ${output.deferred_due_reviews}` : ''}`;
  },
};

function echoOf(
  g: { effective_from: string | null; effective_until: string | null; steering: SteeringGoalDataT },
  today: string,
  resolvedKnowledgeIds: string[],
): RecordSteeringToolOutput['echo'] {
  const st = g.steering;
  return {
    instruction_md: st.instruction_md,
    window: {
      from: g.effective_from,
      until: g.effective_until,
      until_weekday: g.effective_until ? learnerDayWeekday(g.effective_until) : null,
      days_left: steeringDaysLeft(g.effective_until, today),
    },
    scope: {
      resolved_knowledge_ids: [...resolvedKnowledgeIds],
      unresolved: [...st.scope_unresolved],
    },
    excluded_subject_ids: [...st.excluded_subject_ids],
    excluded_knowledge_ids: [...st.excluded_knowledge_ids],
  };
}
