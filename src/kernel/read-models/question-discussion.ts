// One Copilot turn's question / attempt / knowledge association, stored on the
// existing ask and reply event payloads (no parallel table). page_focus is the
// page the learner had open. tool_args is taken from a successful tool call the
// agent chose, and is not a learner confirmation. Derivation readers skip turns
// whose usage policy is not allow, so answer-only and crisis turns stay out.

import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { COPILOT_ASK_ACTIONS, COPILOT_REPLY_ACTION } from '@/kernel/events/copilot-actions';
import { eventAllowsDerivationSql } from '@/kernel/events/derivation-policy';

const MAX_LINKS = 24;
const MAX_TOOL_ROWS = 40;
const EXCERPT_CHARS = 480;
const DEFAULT_FRAGMENT_LIMIT = 20;
const MAX_FRAGMENT_LIMIT = 50;

export const DiscussionEntityKind = z.enum(['question', 'attempt', 'knowledge']);
export type DiscussionEntityKindT = z.infer<typeof DiscussionEntityKind>;

const EntityId = z.string().min(1).max(120);
const ToolName = z.string().min(1).max(80);

export const DiscussionLink = z.discriminatedUnion('source', [
  z.object({
    kind: DiscussionEntityKind,
    id: EntityId,
    source: z.literal('page_focus'),
  }),
  z.object({
    kind: DiscussionEntityKind,
    id: EntityId,
    source: z.literal('tool_args'),
    tool_name: ToolName,
  }),
]);
export type DiscussionLinkT = z.infer<typeof DiscussionLink>;
type ToolArgLink = Extract<DiscussionLinkT, { source: 'tool_args' }>;

export const TurnDiscussion = z.object({
  version: z.literal(1),
  links: z.array(DiscussionLink).min(1).max(MAX_LINKS),
});
export type TurnDiscussionT = z.infer<typeof TurnDiscussion>;

export interface QuestionDiscussionFragment {
  ask_event_id: string;
  reply_event_id: string | null;
  session_id: string | null;
  created_at: string;
  user_excerpt: string;
  reply_excerpt: string | null;
  links: DiscussionLinkT[];
}

const PAGE_FOCUS_KIND: Readonly<Record<string, 'question' | 'attempt'>> = {
  question: 'question',
  attempt: 'attempt',
  answer: 'attempt',
};

const SCALAR_FIELDS: Readonly<Record<string, DiscussionEntityKindT>> = {
  questionId: 'question',
  question_id: 'question',
  parentQuestionId: 'question',
  parent_question_id: 'question',
  existingQuestionId: 'question',
  existing_question_id: 'question',
  source_question_id: 'question',
  root_question_id: 'question',
  variant_question_id: 'question',
  probe_question_id: 'question',
  attemptEventId: 'attempt',
  attempt_event_id: 'attempt',
  source_attempt_event_id: 'attempt',
  knowledgeId: 'knowledge',
  knowledge_id: 'knowledge',
  kc_id: 'knowledge',
  from_knowledge_id: 'knowledge',
  to_knowledge_id: 'knowledge',
};

const ARRAY_FIELDS: Readonly<Record<string, DiscussionEntityKindT>> = {
  questionIds: 'question',
  question_ids: 'question',
  knowledgeIds: 'knowledge',
  knowledge_ids: 'knowledge',
  referenced_knowledge_ids: 'knowledge',
};

/** Tools whose top-level `id` is a knowledge point, not a generic row id. */
const BARE_ID_KIND: Readonly<Record<string, DiscussionEntityKindT>> = {
  get_knowledge_state: 'knowledge',
};

type DbLike = Db | Tx;

function entityId(value: unknown): string | undefined {
  return typeof value === 'string' && EntityId.safeParse(value).success ? value : undefined;
}

function domainToolName(toolName: string): string {
  const parts = toolName.split('__');
  return parts.length >= 3 && parts[0] === 'mcp' ? parts.slice(2).join('__') : toolName;
}

function linkKey(link: DiscussionLinkT): string {
  return link.source === 'tool_args'
    ? `${link.kind}\0${link.id}\0tool_args\0${link.tool_name}`
    : `${link.kind}\0${link.id}\0page_focus`;
}

export function mergeDiscussionLinks(
  links: readonly DiscussionLinkT[],
): TurnDiscussionT | undefined {
  const seen = new Set<string>();
  const kept: DiscussionLinkT[] = [];
  for (const link of links) {
    const parsed = DiscussionLink.safeParse(link);
    if (!parsed.success) continue;
    const key = linkKey(parsed.data);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(parsed.data);
    if (kept.length === MAX_LINKS) break;
  }
  return kept.length === 0 ? undefined : { version: 1, links: kept };
}

export function linksFromToolArgs(toolName: string, args: Record<string, unknown>): ToolArgLink[] {
  const storedName = toolName.slice(0, 80);
  if (!ToolName.safeParse(storedName).success) return [];
  const found: ToolArgLink[] = [];
  const push = (kind: DiscussionEntityKindT, id: string | undefined) => {
    if (!id) return;
    found.push({ kind, id, source: 'tool_args', tool_name: storedName });
  };
  for (const [field, kind] of Object.entries(SCALAR_FIELDS)) push(kind, entityId(args[field]));
  for (const [field, kind] of Object.entries(ARRAY_FIELDS)) {
    const value = args[field];
    if (!Array.isArray(value)) continue;
    for (const item of value) push(kind, entityId(item));
  }
  const bare = BARE_ID_KIND[domainToolName(toolName)];
  if (bare) push(bare, entityId(args.id));
  return found;
}

async function questionIdsByAttempt(
  db: DbLike,
  ids: readonly string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  const found = new Map<string, string>();
  if (unique.length === 0) return found;
  const rows = await db
    .select({
      id: event.id,
      action: event.action,
      subject_kind: event.subject_kind,
      subject_id: event.subject_id,
    })
    .from(event)
    .where(inArray(event.id, unique));
  for (const row of rows) {
    if (row.action === 'attempt' && row.subject_kind === 'question') {
      const questionId = entityId(row.subject_id);
      if (questionId) found.set(row.id, questionId);
    }
  }
  return found;
}

/** Page focus the server accepted for this turn. Other focus kinds are ignored. */
export async function discussionFromPageFocus(
  db: DbLike,
  entity: { kind: string; id: string } | undefined,
): Promise<TurnDiscussionT | undefined> {
  if (!entity) return undefined;
  const kind = PAGE_FOCUS_KIND[entity.kind];
  const id = entityId(entity.id);
  if (!kind || !id) return undefined;
  const links: DiscussionLinkT[] = [{ kind, id, source: 'page_focus' }];
  if (kind === 'attempt') {
    const questionId = (await questionIdsByAttempt(db, [id])).get(id);
    if (questionId) links.push({ kind: 'question', id: questionId, source: 'page_focus' });
  }
  return mergeDiscussionLinks(links);
}

function linksFromToolPayload(payload: unknown): ToolArgLink[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const record = payload as Record<string, unknown>;
  if (typeof record.error_reason === 'string' && record.error_reason.length > 0) return [];
  if (typeof record.tool_name !== 'string') return [];
  const args = record.args;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return [];
  return linksFromToolArgs(record.tool_name, args as Record<string, unknown>);
}

function storedDiscussion(payload: unknown): TurnDiscussionT | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const parsed = TurnDiscussion.safeParse((payload as Record<string, unknown>).discussion);
  return parsed.success ? parsed.data : undefined;
}

/** Page focus already on the ask, plus entities named by successful tool calls. */
export async function assembleTurnDiscussion(
  db: DbLike,
  askEventId: string,
): Promise<TurnDiscussionT | undefined> {
  const [ask] = await db
    .select({ payload: event.payload })
    .from(event)
    .where(eq(event.id, askEventId))
    .limit(1);
  const pageLinks = storedDiscussion(ask?.payload)?.links ?? [];
  const toolRows = await db
    .select({ payload: event.payload })
    .from(event)
    .where(
      and(
        eq(event.action, 'tool_use'),
        eq(event.caused_by_event_id, askEventId),
        eq(event.outcome, 'success'),
      ),
    )
    .orderBy(asc(event.created_at), asc(event.dispatch_seq))
    .limit(MAX_TOOL_ROWS);
  const toolLinks = toolRows.flatMap((row) => linksFromToolPayload(row.payload));
  const questions = await questionIdsByAttempt(
    db,
    toolLinks.filter((link) => link.kind === 'attempt').map((link) => link.id),
  );
  const resolved: DiscussionLinkT[] = [];
  for (const link of toolLinks) {
    resolved.push(link);
    if (link.kind !== 'attempt') continue;
    const questionId = questions.get(link.id);
    if (!questionId) continue;
    resolved.push({
      kind: 'question',
      id: questionId,
      source: 'tool_args',
      tool_name: link.tool_name,
    });
  }
  return mergeDiscussionLinks([...pageLinks, ...resolved]);
}

type DiscussionRow = {
  id: string;
  action: string;
  session_id: string | null;
  payload: Record<string, unknown>;
  caused_by_event_id: string | null;
  created_at: Date;
};

function askIdOf(row: DiscussionRow): string | null {
  if (row.action === COPILOT_REPLY_ACTION) return row.caused_by_event_id;
  return (COPILOT_ASK_ACTIONS as readonly string[]).includes(row.action) ? row.id : null;
}

function mentionsQuestion(discussion: TurnDiscussionT | undefined, questionId: string): boolean {
  return (
    discussion?.links.some((link) => link.kind === 'question' && link.id === questionId) ?? false
  );
}

function textExcerpt(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.length <= EXCERPT_CHARS ? value : value.slice(0, EXCERPT_CHARS);
}

const discussionColumns = {
  id: event.id,
  action: event.action,
  session_id: event.session_id,
  payload: event.payload,
  caused_by_event_id: event.caused_by_event_id,
  created_at: event.created_at,
};

/**
 * Turns whose recorded association names this question. Read-only.
 * Restricted turns (answer-only, crisis) are not returned.
 */
export async function listQuestionDiscussions(
  db: DbLike,
  questionId: string,
  limit = DEFAULT_FRAGMENT_LIMIT,
): Promise<QuestionDiscussionFragment[]> {
  if (!entityId(questionId)) return [];
  const capped = Math.min(Math.max(limit, 1), MAX_FRAGMENT_LIMIT);
  const needle = JSON.stringify({
    discussion: { links: [{ kind: 'question', id: questionId }] },
  });
  const candidates = await db
    .select(discussionColumns)
    .from(event)
    .where(
      and(
        inArray(event.action, [...COPILOT_ASK_ACTIONS, COPILOT_REPLY_ACTION]),
        sql`${event.payload} @> ${needle}::jsonb`,
        eventAllowsDerivationSql(),
      ),
    )
    .orderBy(desc(event.created_at), desc(event.dispatch_seq), desc(event.id))
    .limit(capped * 4);

  const order: string[] = [];
  const seen = new Set<string>();
  for (const row of candidates) {
    const askId = askIdOf(row);
    if (!askId || seen.has(askId)) continue;
    seen.add(askId);
    order.push(askId);
    if (order.length === capped) break;
  }
  if (order.length === 0) return [];

  const rows = await db
    .select(discussionColumns)
    .from(event)
    .where(
      and(
        eventAllowsDerivationSql(),
        or(
          inArray(event.id, order),
          and(eq(event.action, COPILOT_REPLY_ACTION), inArray(event.caused_by_event_id, order)),
        ),
      ),
    );

  const asks = new Map<string, DiscussionRow>();
  const replies = new Map<string, DiscussionRow>();
  for (const row of rows) {
    if (row.action === COPILOT_REPLY_ACTION && row.caused_by_event_id) {
      const prev = replies.get(row.caused_by_event_id);
      if (!prev || row.created_at > prev.created_at) replies.set(row.caused_by_event_id, row);
      continue;
    }
    if (seen.has(row.id)) asks.set(row.id, row);
  }

  const fragments: QuestionDiscussionFragment[] = [];
  for (const askId of order) {
    const ask = asks.get(askId);
    if (!ask) continue;
    const reply = replies.get(askId);
    const replyDiscussion = storedDiscussion(reply?.payload);
    const askDiscussion = storedDiscussion(ask.payload);
    const links = mentionsQuestion(replyDiscussion, questionId)
      ? replyDiscussion?.links
      : mentionsQuestion(askDiscussion, questionId)
        ? askDiscussion?.links
        : undefined;
    if (!links) continue;
    fragments.push({
      ask_event_id: ask.id,
      reply_event_id: reply?.id ?? null,
      session_id: ask.session_id,
      created_at: ask.created_at.toISOString(),
      user_excerpt: textExcerpt(ask.payload.user_message) ?? '',
      reply_excerpt: reply ? textExcerpt(reply.payload.reply_md) : null,
      links,
    });
  }
  return fragments;
}
