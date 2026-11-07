// YUK-1770 record_steering — the companion's direct steering write (D3).
//
// The ONLY hard deterministic gate is verbatim integrity: `learner_words` must
// appear (NFKC, whitespace-collapsed) in a message the learner actually sent in
// the capturing copilot session. Everything else degrades to typed issues:
// unknown KC ids drop to `scope_unresolved` text, an unknown subject becomes an
// issue, and the write still lands — the learner's instruction is a fact the
// moment they said it, not a proposal. The confirmation sentence the companion
// reads back is built ONLY from this tool's result (「记下了…接下来我会…」).

import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { isLearnerLocalDay, learnerLocalDay } from '@/core/learner-day';
import { SteeringGoalData, type SteeringGoalDataT } from '@/core/schema/steering';
import { learnerDayWeekday, quoteAppearsInMessage, steeringDaysLeft } from '@/core/steering';
import { goal, knowledge } from '@/db/schema';
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
  goal_id: z
    .string()
    .min(1)
    .optional()
    .describe('The steering goal to revise/end; omit only when exactly one is active.'),
  /** Verbatim quote from the learner's message this turn (≤500 chars). */
  learner_words: z
    .string()
    .min(1)
    .max(500)
    .describe(
      "Verbatim quote from the learner's CURRENT message (server-checked; paraphrases rejected).",
    ),
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

/** Quotes bind to the server's original ask even on retry. Never search a
 * session-message window: older revoked or later queued messages are not authority.
 */
async function quoteAppearsInCurrentTurnMessage(ctx: ToolContext, quote: string): Promise<boolean> {
  const anchorId = ctx.learnerAskEventId ?? ctx.causedByEventId;
  if (!anchorId) {
    throw new ApiError(
      'validation_error',
      'record_steering 需要本轮 user-ask 事件锚（causedByEventId 缺失）',
      422,
    );
  }
  const { event } = await import('@/db/schema');
  const [ask] = await ctx.db
    .select({ action: event.action, session_id: event.session_id, payload: event.payload })
    .from(event)
    .where(eq(event.id, anchorId))
    .limit(1);
  const message =
    ask && (ASK_ACTIONS as readonly string[]).includes(ask.action)
      ? (ask.payload as { user_message?: unknown }).user_message
      : undefined;
  if (typeof message !== 'string' || message.length === 0) {
    throw new ApiError(
      'validation_error',
      '本轮锚事件不是可校验的学习者消息（user_message 缺失）',
      422,
    );
  }
  if (ctx.sessionId && ask.session_id && ask.session_id !== ctx.sessionId) {
    throw new ApiError('validation_error', '锚事件不属于当前会话', 422);
  }
  return quoteAppearsInMessage(quote, message);
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

/** Canonicalize subject ids. Registered (builtin or hydrated custom) subjects
 * resolve through the registry; an unregistered name is accepted ONLY when the
 * knowledge tree positively carries that domain (a live custom subject). A
 * real unknown — e.g. 「物理」 when the registry only knows `physics` — produces
 * the typed issue so the model corrects it instead of writing a silently
 * no-op exclusion (P1-3). No hard-coded alias table; Chinese names resolve
 * only if the tree itself was built with them as domains. */
async function resolveSubjectIds(
  ctx: ToolContext,
  raw: string[],
  issues: RecordSteeringToolOutput['issues'],
  issueKind: 'subject_unknown' | 'exclude_subject_unknown',
): Promise<string[]> {
  const out: string[] = [];
  const liveCache = new Map<string, number>();
  for (const id of raw) {
    const canonical = resolveKnownSubjectId(id);
    if (canonical !== null) {
      if (!out.includes(canonical)) out.push(canonical);
      continue;
    }
    const normalized = normalizeSubjectKey(id);
    if (normalized === '') {
      issues.push({ kind: issueKind, detail: id });
      continue;
    }
    // Unregistered: honest only if the tree positively carries the domain.
    let liveCount = liveCache.get(normalized);
    if (liveCount === undefined) {
      liveCount = (await resolveSubjectKnowledgeIds(ctx.db, normalized)).length;
      liveCache.set(normalized, liveCount);
    }
    if (liveCount > 0) {
      if (!out.includes(normalized)) out.push(normalized);
    } else {
      issues.push({ kind: issueKind, detail: id });
    }
  }
  return out;
}

/** D4 cost statement input, via the kernel steering port: practice installs
 * the counter that runs the SAME due query with deferral suppressed, so the
 * number the learner hears matches the three-segment filter exactly (P1 fix).
 * null when the port is not installed (report unknown, never guess zero). */
async function countDeferredDueReviews(ctx: ToolContext, now: Date): Promise<number | null> {
  try {
    const { steeringDeferredDueCount } = await import('@/kernel/steering-recompose');
    return await steeringDeferredDueCount(ctx.db, now);
  } catch (err) {
    console.error('[record_steering] deferred-due count unavailable', { err });
    return null;
  }
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

export const recordSteeringTool: DomainTool<RecordSteeringToolInput, RecordSteeringToolOutput> = {
  name: 'record_steering',
  description:
    "MUST be called FIRST — before any advice or proposal — whenever the learner states an exam/quiz date or scope, a study deadline, a priority change, or cancels a prior arrangement. Writes directly, no proposal; never substitute a knowledge-tree proposal or a spoken-only recap for this call. Build the confirmation ONLY from the result's echo/issues/preparing; unmappable scope stays as text.",
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

    // ── hard gate: the quote must come from THIS turn's user-ask event ──
    if (!(await quoteAppearsInCurrentTurnMessage(ctx, input.learner_words))) {
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

    // create / revise share the payload build. On revise, an omitted structural
    // field (window / scope / exclude / metadata) CARRIES OVER the recorded
    // value — a learner changing only the date must not silently lift the
    // physics deferral or drop the mapped scope. A present (even empty) field
    // replaces, so revocations stay expressible.
    const reviseRow =
      input.op === 'revise'
        ? ((
            await ctx.db
              .select({
                id: goal.id,
                scope_knowledge_ids: goal.scope_knowledge_ids,
                effective_from: goal.effective_from,
                effective_until: goal.effective_until,
                steering: goal.steering,
              })
              .from(goal)
              .where(eq(goal.id, await resolveSingleSteeringGoalId(ctx, input.goal_id)))
              .limit(1)
          )[0] ?? null)
        : null;
    if (input.op === 'revise' && (reviseRow === null || reviseRow.steering === null)) {
      throw new ApiError('not_found', 'unknown steering goal', 404);
    }
    const prior = reviseRow?.steering ?? null;
    if (!input.instruction_md) {
      throw new ApiError('validation_error', `${input.op} requires instruction_md`, 400);
    }
    // Window: create defaults from=today; revise keeps the recorded window when
    // the patch omits it. Reject inverted ranges; create rejects a past until.
    const from =
      input.op === 'create'
        ? (input.window?.from ?? today)
        : input.window
          ? input.window.from
          : (reviseRow?.effective_from ?? null);
    const until =
      input.op === 'create'
        ? (input.window?.until ?? null)
        : input.window
          ? input.window.until
          : (reviseRow?.effective_until ?? null);
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
      ? ((await resolveSubjectIds(ctx, [input.subject_id], issues, 'subject_unknown'))[0] ?? null)
      : null;

    // Scope: omitted on revise carries over the recorded mapping (ids + text +
    // unresolved); a present scope replaces it wholesale.
    const scopeInput =
      input.scope ??
      (input.op === 'revise' && prior
        ? {
            text: prior.scope_text,
            knowledge_ids: reviseRow?.scope_knowledge_ids ?? [],
            unresolved: [...prior.scope_unresolved],
          }
        : undefined);
    const requestedIds = scopeInput?.knowledge_ids ?? [];
    const resolvedIds = await resolveScopeKnowledgeIds(ctx, requestedIds, issues);
    const unresolved = [...(scopeInput?.unresolved ?? [])];
    const scopeText = scopeInput?.text ?? null;

    // Exclusions (D4): omitted on revise carries over; a present exclude replaces.
    const excludeInput =
      input.exclude ??
      (input.op === 'revise' && prior
        ? {
            subject_ids: [...prior.excluded_subject_ids],
            knowledge_ids: [...prior.excluded_knowledge_ids],
          }
        : undefined);
    const excludedSubjects = await resolveSubjectIds(
      ctx,
      excludeInput?.subject_ids ?? [],
      issues,
      'exclude_subject_unknown',
    );
    const excludedKnowledgeIds = await (async () => {
      const raw = excludeInput?.knowledge_ids ?? [];
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
      metadata: input.metadata ?? prior?.metadata ?? {},
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
      const deferred = await countDeferredDueReviews(ctx, now);
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

    // revise (row already fetched and validated above)
    const row = reviseRow;
    if (row === null || row.steering === null) {
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
    const deferred = await countDeferredDueReviews(ctx, now);
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
