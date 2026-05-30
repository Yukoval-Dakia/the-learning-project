// YUK-81 / Foundation D M1 Lane C
//
// `query_events` — generic event-stream reader. Goes directly against the
// `event` table (bypassing the parseEvent envelope) because the
// discriminated KnownEvent union narrows field types in a way that's
// painful to consume generically — but the raw row columns are all the
// LLM needs (id / actor / action / subject / outcome / caused_by /
// created_at).

import { event } from '@/db/schema';
import { and, desc, eq, gte } from 'drizzle-orm';
import { z } from 'zod';
// P5.1 / YUK-143 — courtesy default (20) centralized in budgets.ts;
// byte-unchanged from the prior inline literal.
import { TOOL_COURTESY_DEFAULTS } from './budgets';
import type { DomainTool, ToolContext } from './types';

const InputSchema = z.object({
  filter: z
    .object({
      actorKind: z.enum(['user', 'agent', 'cron', 'system']).optional(),
      actorRef: z.string().optional(),
      action: z.string().optional(),
      subjectKind: z.string().optional(),
      subjectId: z.string().optional(),
      outcome: z.enum(['success', 'failure', 'partial']).optional(),
      causedByEventId: z.string().optional(),
      sinceDays: z.number().int().positive().max(180).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    })
    .optional(),
});

const EventRowSchema = z.object({
  id: z.string(),
  actor_kind: z.string(),
  actor_ref: z.string(),
  action: z.string(),
  subject_kind: z.string(),
  subject_id: z.string(),
  outcome: z.string().nullable(),
  caused_by_event_id: z.string().nullable(),
  created_at: z.string(),
  session_id: z.string().nullable(),
});

const OutputSchema = z.object({
  events: z.array(EventRowSchema),
  total: z.number().int().nonnegative(),
  filter_applied: z.record(z.unknown()),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

const DESCRIPTION = [
  'Read recent events from the action log. Used to answer "what has the user / agent / cron been doing".',
  '',
  'Filters compose AND-style. All are optional.',
  '- filter.actorKind: user | agent | cron | system',
  '- filter.actorRef: e.g. "self", "AttributionTask", "agent:dreaming:variant_propose"',
  '- filter.action: attempt | judge | propose | generate | review | rate | correct | experimental:*',
  '- filter.subjectKind: question | knowledge | knowledge_edge | event | artifact | record | ...',
  '- filter.subjectId: only events about this subject',
  '- filter.outcome: success | failure | partial',
  '- filter.causedByEventId: only events whose caused_by_event_id matches (chain traversal)',
  '- filter.sinceDays: only events created within the last N days (≤180)',
  '- filter.limit: 1–50, default 20.',
  '',
  'Returns rows ordered desc by created_at. Each row carries caused_by_event_id for client-side chain walking.',
].join('\n');

async function execute(ctx: ToolContext, raw: Input): Promise<Output> {
  const input = InputSchema.parse(raw);
  const filter = input.filter ?? {};
  const limit = filter.limit ?? TOOL_COURTESY_DEFAULTS.query_events;
  const since = filter.sinceDays ? new Date(Date.now() - filter.sinceDays * 86_400_000) : undefined;

  const conditions = [];
  if (filter.actorKind) conditions.push(eq(event.actor_kind, filter.actorKind));
  if (filter.actorRef) conditions.push(eq(event.actor_ref, filter.actorRef));
  if (filter.action) conditions.push(eq(event.action, filter.action));
  if (filter.subjectKind) conditions.push(eq(event.subject_kind, filter.subjectKind));
  if (filter.subjectId) conditions.push(eq(event.subject_id, filter.subjectId));
  if (filter.outcome) conditions.push(eq(event.outcome, filter.outcome));
  if (filter.causedByEventId) conditions.push(eq(event.caused_by_event_id, filter.causedByEventId));
  if (since) conditions.push(gte(event.created_at, since));

  const baseQuery = ctx.db
    .select({
      id: event.id,
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
  const rows = await filtered.orderBy(desc(event.created_at), desc(event.id)).limit(limit);

  return OutputSchema.parse({
    events: rows.map((r) => ({
      id: r.id,
      actor_kind: r.actor_kind,
      actor_ref: r.actor_ref,
      action: r.action,
      subject_kind: r.subject_kind,
      subject_id: r.subject_id,
      outcome: r.outcome ?? null,
      caused_by_event_id: r.caused_by_event_id ?? null,
      created_at: r.created_at.toISOString(),
      session_id: r.session_id ?? null,
    })),
    total: rows.length,
    filter_applied: {
      actorKind: filter.actorKind ?? null,
      actorRef: filter.actorRef ?? null,
      action: filter.action ?? null,
      subjectKind: filter.subjectKind ?? null,
      subjectId: filter.subjectId ?? null,
      outcome: filter.outcome ?? null,
      causedByEventId: filter.causedByEventId ?? null,
      sinceDays: filter.sinceDays ?? null,
      limit,
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
