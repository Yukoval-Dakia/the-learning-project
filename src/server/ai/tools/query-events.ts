// YUK-81 / Foundation D M1 Lane C
//
// `query_events` — generic event-stream reader. Goes directly against the
// `event` table (bypassing the parseEvent envelope) because the
// discriminated KnownEvent union narrows field types in a way that's
// painful to consume generically — but the raw row columns are all the
// LLM needs (id / actor / action / subject / outcome / caused_by /
// created_at).

import { event } from '@/db/schema';
import { getCorrectionStatuses } from '@/kernel/events';
import { and, desc, eq, gte, lt, lte, max, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
// P5.1 / YUK-143 — courtesy default (20) centralized in budgets.ts;
// byte-unchanged from the prior inline literal.
import { TOOL_COURTESY_DEFAULTS } from './budgets';
import type { DomainTool, ToolContext } from './types';

const CursorSchema = z.object({
  createdAt: z.string().datetime(),
  dispatchSeq: z.number().int().positive(),
  id: z.string().min(1),
  observedAt: z.string().datetime(),
  observedDispatchSeq: z.number().int().nonnegative(),
  windowStart: z.string().datetime().nullable(),
  sinceDays: z.number().int().positive().max(180).nullable(),
  filterKey: z.string().min(1),
});

// Keep the public tool input as a ZodObject. The MCP bridge intentionally
// consumes `.shape`; a top-level refine/superRefine would turn this into a
// ZodEffects and make query_events impossible to register.
const InputSchema = z.object({
  filter: z
    .object({
      eventId: z.string().min(1).optional(),
      actorKind: z.enum(['user', 'agent', 'cron', 'system']).optional(),
      actorRef: z.string().optional(),
      action: z.string().optional(),
      subjectKind: z.string().optional(),
      subjectId: z.string().optional(),
      outcome: z.enum(['success', 'failure', 'partial']).optional(),
      causedByEventId: z.string().optional(),
      siblingOfEventId: z.string().min(1).optional(),
      sinceDays: z.number().int().positive().max(180).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    })
    .optional(),
  cursor: CursorSchema.optional(),
});

const EventRowSchema = z.object({
  id: z.string(),
  dispatch_seq: z.number().int().positive(),
  actor_kind: z.string(),
  actor_ref: z.string(),
  action: z.string(),
  subject_kind: z.string(),
  subject_id: z.string(),
  outcome: z.string().nullable(),
  caused_by_event_id: z.string().nullable(),
  created_at: z.string(),
  session_id: z.string().nullable(),
  correction_state: z.enum(['active', 'retracted', 'marked_wrong', 'superseded']),
  correction_event_id: z.string().nullable(),
  replacement_event_id: z.string().nullable(),
});

const OutputSchema = z.object({
  events: z.array(EventRowSchema),
  // Compatibility: this remains the number of rows in this page, never the
  // number of all matching rows. Use coverage.has_more before claiming full coverage.
  total: z.number().int().nonnegative(),
  filter_applied: z.record(z.unknown()),
  subject_scope: z.object({
    subject_id: z.string().nullable(),
    subject_kind: z.string().nullable(),
    all_subject_kinds_included: z.boolean().nullable(),
    cross_stage_claim_status: z.enum([
      'not_subject_scoped',
      'blocked_subject_id_only_filter_required',
      'blocked_more_pages_unread',
      'requires_complete_pagination_chain',
      'authorized_complete_window_in_response',
    ]),
    required_followup: z.enum([
      'none',
      'repeat_with_subject_id_only',
      'follow_next_cursor_and_aggregate_from_initial_page',
      'verify_complete_pagination_chain_from_initial_page',
    ]),
  }),
  match_semantics: z.object({
    filters: z.literal('and'),
    action: z.literal('exact'),
    event_id: z.literal('exact'),
    subject_id: z.literal('exact'),
    subject_kind: z.literal('exact'),
    caused_by: z.literal('direct_children_only'),
    sibling: z.literal('same_non_null_parent_excludes_focal'),
  }),
  claim_boundaries: z.object({
    zero_rows_scope: z.enum([
      'exact_filters_and_full_observation_window',
      'exact_filters_and_remaining_observation_window_after_cursor',
    ]),
    supports_entity_inventory_claim: z.literal(false),
    supports_lifecycle_status_count_claim: z.literal(false),
  }),
  relation_applied: z.object({
    kind: z.enum(['none', 'direct_children', 'siblings']),
    focal_event_id: z.string().nullable().optional(),
    parent_event_id: z.string().nullable().optional(),
    status: z.enum(['not_requested', 'applied', 'focal_not_found', 'focal_has_no_parent']),
  }),
  coverage: z.object({
    returned_count: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    has_more: z.boolean(),
    complete_for_window: z.boolean(),
    complete_for_window_scope: z.literal('response_contains_full_filter_observation_window'),
    remaining_window_after_cursor_complete: z.boolean().nullable(),
    next_cursor: CursorSchema.nullable(),
    order: z.literal('created_at_desc_dispatch_seq_desc_id_desc'),
    observed_at: z.string().datetime(),
    observed_dispatch_seq: z.number().int().nonnegative(),
    window_start: z.string().datetime().nullable(),
  }),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

function filterKey(filter: NonNullable<Input['filter']> | undefined): string {
  return JSON.stringify([
    filter?.eventId ?? null,
    filter?.actorKind ?? null,
    filter?.actorRef ?? null,
    filter?.action ?? null,
    filter?.subjectKind ?? null,
    filter?.subjectId ?? null,
    filter?.outcome ?? null,
    filter?.causedByEventId ?? null,
    filter?.siblingOfEventId ?? null,
    filter?.sinceDays ?? null,
  ]);
}

const DESCRIPTION = [
  'Read recent events from the action log. Used to answer "what has the user / agent / cron been doing".',
  '',
  'Filters compose AND-style. All are optional.',
  '- filter.eventId: exact event id (never infers action from the id text)',
  '- filter.actorKind: user | agent | cron | system',
  '- filter.actorRef: e.g. "self", "AttributionTask", "agent:dreaming:variant_propose"',
  '- filter.action: exact action equality, e.g. attempt is not experimental:*attempt*',
  '- filter.subjectKind: question | knowledge | knowledge_edge | event | artifact | record | ...',
  '- filter.subjectId: only events about this subject',
  '- filter.outcome: success | failure | partial',
  '- filter.causedByEventId: direct children only; it does not return siblings or descendants',
  '- filter.siblingOfEventId: events with the same non-null causal parent, excluding the focal event',
  '- filter.sinceDays: only events created within the last N days (≤180)',
  '- filter.limit: 1–50, default 20.',
  '- cursor: continue an incomplete page using the returned coverage.next_cursor.',
  '',
  'Returns rows ordered by created_at DESC, dispatch_seq DESC, id DESC. dispatch_seq is the',
  'authoritative insertion chronology when timestamps tie. A zero-row result is complete only for the',
  'reported filter/time window when no cursor was supplied and coverage.complete_for_window=true.',
  'A cursor response contains only the remaining rows after that cursor; has_more=false then completes',
  'that remainder, not the full window in this response.',
  'When tracing evidence for one subject id across a pipeline, omit subjectKind: subject kinds may',
  'change between hops (for example knowledge → mind_model). A cross-stage negative claim requires',
  'a subjectId-only filter (plus optional limit) and a complete first page or complete cursor chain.',
  'subject_scope.cross_stage_claim_status and required_followup expose whether that boundary is met.',
  'This is an event log, not an entity inventory: even a complete zero-row event window cannot prove',
  'that LearningItem or intervention entities are absent, or that any lifecycle status has count zero.',
  'It must not override get_review_due.entity_status_coverage=not_observed.',
  'Inspect correction_state before treating a returned event as current evidence.',
].join('\n');

async function execute(ctx: ToolContext, raw: Input): Promise<Output> {
  const input = InputSchema.parse(raw);
  const filter = input.filter ?? {};
  if (filter.siblingOfEventId && (filter.causedByEventId || filter.eventId)) {
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        message: 'siblingOfEventId cannot be combined with eventId or causedByEventId',
        path: ['filter', 'siblingOfEventId'],
      },
    ]);
  }
  if (input.cursor && (filter.sinceDays ?? null) !== input.cursor.sinceDays) {
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        message: 'cursor sinceDays must match filter.sinceDays',
        path: ['cursor', 'sinceDays'],
      },
    ]);
  }
  const currentFilterKey = filterKey(input.filter);
  if (input.cursor && currentFilterKey !== input.cursor.filterKey) {
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        message: 'cursor must be reused with the same event filters',
        path: ['cursor', 'filterKey'],
      },
    ]);
  }
  const limit = filter.limit ?? TOOL_COURTESY_DEFAULTS.query_events;
  const observedAt = input.cursor ? new Date(input.cursor.observedAt) : new Date();
  const observedDispatchSeq = input.cursor
    ? input.cursor.observedDispatchSeq
    : Number((await ctx.db.select({ value: max(event.dispatch_seq) }).from(event))[0]?.value ?? 0);
  const since = input.cursor?.windowStart
    ? new Date(input.cursor.windowStart)
    : filter.sinceDays
      ? new Date(observedAt.getTime() - filter.sinceDays * 86_400_000)
      : undefined;

  const conditions = [];
  if (filter.eventId) conditions.push(eq(event.id, filter.eventId));
  if (filter.actorKind) conditions.push(eq(event.actor_kind, filter.actorKind));
  if (filter.actorRef) conditions.push(eq(event.actor_ref, filter.actorRef));
  if (filter.action) conditions.push(eq(event.action, filter.action));
  if (filter.subjectKind) conditions.push(eq(event.subject_kind, filter.subjectKind));
  if (filter.subjectId) conditions.push(eq(event.subject_id, filter.subjectId));
  if (filter.outcome) conditions.push(eq(event.outcome, filter.outcome));
  if (filter.causedByEventId) conditions.push(eq(event.caused_by_event_id, filter.causedByEventId));
  if (since) conditions.push(gte(event.created_at, since));
  // observed_at is a real snapshot upper bound, not merely a label. This also
  // excludes future-dated rows and prevents inserts between pages from entering
  // the claimed coverage window.
  conditions.push(lte(event.created_at, observedAt));
  // Freeze the insertion high-water too: created_at is caller-supplied on
  // imports/backfills, so a later insert may legitimately be backdated inside
  // the time window. It still must not enter an already-started enumeration.
  conditions.push(lte(event.dispatch_seq, observedDispatchSeq));
  if (input.cursor) {
    const cursorAt = new Date(input.cursor.createdAt);
    conditions.push(
      or(
        lt(event.created_at, cursorAt),
        and(eq(event.created_at, cursorAt), lt(event.dispatch_seq, input.cursor.dispatchSeq)),
        and(
          eq(event.created_at, cursorAt),
          eq(event.dispatch_seq, input.cursor.dispatchSeq),
          lt(event.id, input.cursor.id),
        ),
      ) as NonNullable<ReturnType<typeof or>>,
    );
  }

  let relationApplied: z.infer<typeof OutputSchema>['relation_applied'] = {
    kind: 'none',
    status: 'not_requested',
  };
  if (filter.causedByEventId) {
    relationApplied = {
      kind: 'direct_children',
      parent_event_id: filter.causedByEventId,
      status: 'applied',
    };
  }
  if (filter.siblingOfEventId) {
    const [focal] = await ctx.db
      .select({ id: event.id, parent_event_id: event.caused_by_event_id })
      .from(event)
      .where(eq(event.id, filter.siblingOfEventId))
      .limit(1);
    if (!focal) {
      conditions.push(sql`false`);
      relationApplied = {
        kind: 'siblings',
        focal_event_id: filter.siblingOfEventId,
        parent_event_id: null,
        status: 'focal_not_found',
      };
    } else if (!focal.parent_event_id) {
      conditions.push(sql`false`);
      relationApplied = {
        kind: 'siblings',
        focal_event_id: focal.id,
        parent_event_id: null,
        status: 'focal_has_no_parent',
      };
    } else {
      conditions.push(eq(event.caused_by_event_id, focal.parent_event_id), ne(event.id, focal.id));
      relationApplied = {
        kind: 'siblings',
        focal_event_id: focal.id,
        parent_event_id: focal.parent_event_id,
        status: 'applied',
      };
    }
  }

  const baseQuery = ctx.db
    .select({
      id: event.id,
      dispatch_seq: event.dispatch_seq,
      session_id: event.session_id,
      actor_kind: event.actor_kind,
      actor_ref: event.actor_ref,
      action: event.action,
      subject_kind: event.subject_kind,
      subject_id: event.subject_id,
      outcome: event.outcome,
      caused_by_event_id: event.caused_by_event_id,
      created_at: event.created_at,
    })
    .from(event);
  const filtered = conditions.length > 0 ? baseQuery.where(and(...conditions)) : baseQuery;
  const candidateRows = await filtered
    .orderBy(desc(event.created_at), desc(event.dispatch_seq), desc(event.id))
    .limit(limit + 1);
  const hasMore = candidateRows.length > limit;
  const rows = candidateRows.slice(0, limit);
  const lastRow = rows.at(-1);
  const hasCrossStageNarrowingFilter =
    filter.eventId !== undefined ||
    filter.actorKind !== undefined ||
    filter.actorRef !== undefined ||
    filter.action !== undefined ||
    filter.subjectKind !== undefined ||
    filter.outcome !== undefined ||
    filter.causedByEventId !== undefined ||
    filter.siblingOfEventId !== undefined ||
    filter.sinceDays !== undefined;
  const crossStageClaimStatus: z.infer<
    typeof OutputSchema
  >['subject_scope']['cross_stage_claim_status'] = !filter.subjectId
    ? 'not_subject_scoped'
    : hasCrossStageNarrowingFilter
      ? 'blocked_subject_id_only_filter_required'
      : input.cursor
        ? 'requires_complete_pagination_chain'
        : hasMore
          ? 'blocked_more_pages_unread'
          : 'authorized_complete_window_in_response';
  const requiredCrossStageFollowup: z.infer<
    typeof OutputSchema
  >['subject_scope']['required_followup'] = !filter.subjectId
    ? 'none'
    : hasCrossStageNarrowingFilter
      ? 'repeat_with_subject_id_only'
      : input.cursor
        ? 'verify_complete_pagination_chain_from_initial_page'
        : hasMore
          ? 'follow_next_cursor_and_aggregate_from_initial_page'
          : 'none';
  const correctionStatuses = await getCorrectionStatuses(
    ctx.db,
    rows.map((row) => row.id),
  );

  return OutputSchema.parse({
    events: rows.map((r) => {
      const correction = correctionStatuses.get(r.id);
      return {
        id: r.id,
        dispatch_seq: r.dispatch_seq,
        actor_kind: r.actor_kind,
        actor_ref: r.actor_ref,
        action: r.action,
        subject_kind: r.subject_kind,
        subject_id: r.subject_id,
        outcome: r.outcome ?? null,
        caused_by_event_id: r.caused_by_event_id ?? null,
        created_at: r.created_at.toISOString(),
        session_id: r.session_id ?? null,
        correction_state: correction?.state ?? 'active',
        correction_event_id: correction?.correction_event_id ?? null,
        replacement_event_id: correction?.replacement_event_id ?? null,
      };
    }),
    total: rows.length,
    filter_applied: {
      eventId: filter.eventId ?? null,
      actorKind: filter.actorKind ?? null,
      actorRef: filter.actorRef ?? null,
      action: filter.action ?? null,
      subjectKind: filter.subjectKind ?? null,
      subjectId: filter.subjectId ?? null,
      outcome: filter.outcome ?? null,
      causedByEventId: filter.causedByEventId ?? null,
      siblingOfEventId: filter.siblingOfEventId ?? null,
      sinceDays: filter.sinceDays ?? null,
      limit,
    },
    subject_scope: {
      subject_id: filter.subjectId ?? null,
      subject_kind: filter.subjectKind ?? null,
      all_subject_kinds_included: filter.subjectId ? filter.subjectKind === undefined : null,
      cross_stage_claim_status: crossStageClaimStatus,
      required_followup: requiredCrossStageFollowup,
    },
    match_semantics: {
      filters: 'and',
      action: 'exact',
      event_id: 'exact',
      subject_id: 'exact',
      subject_kind: 'exact',
      caused_by: 'direct_children_only',
      sibling: 'same_non_null_parent_excludes_focal',
    },
    claim_boundaries: {
      zero_rows_scope: input.cursor
        ? 'exact_filters_and_remaining_observation_window_after_cursor'
        : 'exact_filters_and_full_observation_window',
      supports_entity_inventory_claim: false,
      supports_lifecycle_status_count_claim: false,
    },
    relation_applied: relationApplied,
    coverage: {
      returned_count: rows.length,
      limit,
      has_more: hasMore,
      complete_for_window: !input.cursor && !hasMore,
      complete_for_window_scope: 'response_contains_full_filter_observation_window',
      remaining_window_after_cursor_complete: input.cursor ? !hasMore : null,
      next_cursor:
        hasMore && lastRow
          ? {
              createdAt: lastRow.created_at.toISOString(),
              dispatchSeq: lastRow.dispatch_seq,
              id: lastRow.id,
              observedAt: observedAt.toISOString(),
              observedDispatchSeq,
              windowStart: since?.toISOString() ?? null,
              sinceDays: filter.sinceDays ?? null,
              filterKey: currentFilterKey,
            }
          : null,
      order: 'created_at_desc_dispatch_seq_desc_id_desc',
      observed_at: observedAt.toISOString(),
      observed_dispatch_seq: observedDispatchSeq,
      window_start: since?.toISOString() ?? null,
    },
  });
}

function summarize(input: Input, output: Output): string {
  const f = input.filter ?? {};
  const parts: string[] = [`${output.total} rows`];
  if (f.action) parts.push(`action=${f.action}`);
  if (f.actorKind) parts.push(`actor=${f.actorKind}`);
  if (f.subjectKind) parts.push(`subj=${f.subjectKind}`);
  if (f.causedByEventId) parts.push(`caused_by=${f.causedByEventId.slice(0, 8)}…`);
  if (f.siblingOfEventId) parts.push(`sibling_of=${f.siblingOfEventId.slice(0, 8)}…`);
  if (f.sinceDays) parts.push(`since≤${f.sinceDays}d`);
  if (output.coverage.has_more) parts.push('more');
  return `events · ${parts.join(' · ')}`;
}

export const queryEventsTool: DomainTool<Input, Output> = {
  name: 'query_events',
  description: DESCRIPTION,
  effect: 'read',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  costClass: 'local',
  execute,
  summarize,
  mirrorEvent: 'when_user_visible',
};
