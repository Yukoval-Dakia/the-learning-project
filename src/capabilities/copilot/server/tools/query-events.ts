// `query_events` — generic event-stream reader over the `event` table. It bypasses
// the parseEvent envelope because the discriminated KnownEvent union narrows fields
// in a way that is painful to consume generically, while the raw columns (id /
// actor / action / subject / outcome / caused_by / created_at) are all the LLM needs.

import { and, desc, eq, gte, lt, lte, max, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { event } from '@/db/schema';
import { getCorrectionStatuses } from '@/kernel/events';
import { eventAllowsDerivationSql } from '@/kernel/events/derivation-policy';
// Courtesy default (20) lives in budgets.ts.
import { TOOL_COURTESY_DEFAULTS } from '@/kernel/tools/budgets';
import type { DomainTool, ToolContext } from '@/kernel/tools/types';

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

// An exact string filter must never have two meanings: an explicit
// empty/whitespace value must not survive into filter_applied while the SQL
// builder treats the same value as "filter omitted" via a truthiness check.
const ExactStringSchema = z.string().trim().min(1);

// Keep the public tool input as a ZodObject because the MCP bridge consumes `.shape`.
const InputSchema = z.object({
  filter: z
    .object({
      eventId: ExactStringSchema.optional(),
      actorKind: z.enum(['user', 'agent', 'cron', 'system']).optional(),
      actorRef: ExactStringSchema.optional(),
      action: ExactStringSchema.optional(),
      subjectKind: ExactStringSchema.optional(),
      subjectId: ExactStringSchema.optional(),
      outcome: z.enum(['success', 'failure', 'partial']).optional(),
      causedByEventId: ExactStringSchema.optional(),
      siblingOfEventId: ExactStringSchema.optional(),
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
  required_followup: z.enum(['none', 'continue_with_next_cursor']),
  events: z.array(EventRowSchema),
  // Compatibility: total is this page's row count, never the number of all
  // matching rows. Check coverage.has_more before claiming full coverage.
  total: z.number().int().nonnegative(),
  filter_applied: z.record(z.string(), z.unknown()),
  subject_scope: z.object({
    subject_id: z.string().nullable(),
    subject_kind: z.string().nullable(),
    all_subject_kinds_included: z.boolean().nullable(),
    // subject_id is exact. Causal children commonly change subject_id (for
    // example knowledge -> conjecture -> probe question), so this reader never
    // claims that an exact subject window includes those descendants.
    causal_descendants_included: z.literal(false).nullable(),
    cross_stage_claim_status: z.enum([
      'not_subject_scoped',
      'window_complete',
      'remaining_window_complete',
      'blocked_more_pages_unread',
    ]),
    required_followup: z.enum(['none', 'continue_with_next_cursor']),
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
    supports_cross_subject_causal_descendant_claim: z.literal(false),
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
  'Read paginated action-log history, not current entity inventory. Filters compose exact AND matches.',
  'subjectId is one exact entity id, not a domain; subjectKind further narrows that id.',
  'causedByEventId selects direct children; siblingOfEventId selects the same non-null parent, excluding the focal event.',
  'required_followup none: do not repeat this filter, including when the page has zero rows. none does not mean this response contains the whole window.',
  'required_followup continue_with_next_cursor: resubmit the same filters with coverage.next_cursor. Do not drop filters or walk other events.',
  'window_complete: no cursor was passed, and a subject-scoped window is fully returned. It does not include causal descendants.',
  'remaining_window_complete: a cursor was passed and no further pages remain. coverage.complete_for_window stays false. Do not claim rows before the cursor.',
  'sinceDays is at most 180; limit is 1–50 (default 20).',
].join('\n');

type ClaimStatus =
  | 'not_subject_scoped'
  | 'window_complete'
  | 'remaining_window_complete'
  | 'blocked_more_pages_unread';

/** One page has one next step. A cursor page never claims the rows before it. */
function observationStep(input: { subjectScoped: boolean; hasMore: boolean; cursor: boolean }): {
  cross_stage_claim_status: ClaimStatus;
  required_followup: 'none' | 'continue_with_next_cursor';
} {
  if (input.hasMore) {
    return {
      cross_stage_claim_status: 'blocked_more_pages_unread',
      required_followup: 'continue_with_next_cursor',
    };
  }
  if (!input.subjectScoped) {
    return { cross_stage_claim_status: 'not_subject_scoped', required_followup: 'none' };
  }
  if (input.cursor) {
    return { cross_stage_claim_status: 'remaining_window_complete', required_followup: 'none' };
  }
  return { cross_stage_claim_status: 'window_complete', required_followup: 'none' };
}

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

  const conditions = [eventAllowsDerivationSql()];
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
      .where(and(eq(event.id, filter.siblingOfEventId), eventAllowsDerivationSql()))
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
  const step = observationStep({
    subjectScoped: filter.subjectId !== undefined,
    hasMore,
    cursor: input.cursor !== undefined,
  });
  const correctionStatuses = await getCorrectionStatuses(
    ctx.db,
    rows.map((row) => row.id),
  );

  return OutputSchema.parse({
    required_followup: step.required_followup,
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
      causal_descendants_included: filter.subjectId ? false : null,
      cross_stage_claim_status: step.cross_stage_claim_status,
      required_followup: step.required_followup,
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
      supports_cross_subject_causal_descendant_claim: false,
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
  const parts: string[] = [
    output.coverage.has_more
      ? `${output.total} rows · more`
      : output.coverage.complete_for_window
        ? `${output.total} rows · window complete`
        : `${output.total} rows · cursor remainder`,
  ];
  if (f.action) parts.push(`action=${f.action}`);
  if (f.actorKind) parts.push(`actor=${f.actorKind}`);
  if (f.subjectKind) parts.push(`subj=${f.subjectKind}`);
  if (f.causedByEventId) parts.push(`caused_by=${f.causedByEventId.slice(0, 8)}…`);
  if (f.siblingOfEventId) parts.push(`sibling_of=${f.siblingOfEventId.slice(0, 8)}…`);
  if (f.sinceDays) parts.push(`since≤${f.sinceDays}d`);
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
