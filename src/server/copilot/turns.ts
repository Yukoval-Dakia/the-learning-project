// AF S3a / YUK-203 U3 — Copilot turn reader (replay-last-N).
//
// Reads the recent Copilot conversation turns from the event stream and returns
// them oldest→newest so the drawer can prefill its message list on open.
//
// A "turn" is one row: a user ask (`experimental:copilot_user_ask`) or a chip
// trigger (`experimental:copilot_chip_trigger`) → role 'user'; an agent reply
// (`experimental:copilot_reply`) → role 'ai'. We read the newest `limit` rows of
// EACH side and interleave by (created_at, id), then keep the last `limit` of the
// merged stream. This guarantees ask+reply pairs stay adjacent regardless of how
// many tool-loop seconds separated them.
//
// No new schema: all three actions live in the generic ExperimentalEvent escape
// hatch and carry their text in payload. Replay is scoped to the CURRENT
// reusable Copilot session (codex #3356884484): we resolve that session with the
// same predicate find-or-create uses (Conversation.findReusableCopilotConversation),
// then filter events by the events.session_id column — which every Copilot turn
// event now writes (ask/chip + reply), the column being the event's conversation
// session (teaching + copilot share it; payload.session_id is a portable copy).

import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { findReusableCopilotConversation } from '@/server/session/conversation';
import { and, desc, eq, inArray, or } from 'drizzle-orm';

export type CopilotTurnRole = 'user' | 'ai';

export interface CopilotTurn {
  role: CopilotTurnRole;
  text: string;
  at: string; // ISO timestamp
  event_id: string;
}

const USER_ACTIONS = [
  'experimental:copilot_user_ask',
  'experimental:copilot_chip_trigger',
] as const;
const REPLY_ACTION = 'experimental:copilot_reply';

const DEFAULT_TURN_LIMIT = 20;
const MAX_TURN_LIMIT = 100;

type DbLike = Db | Tx;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || Number.isNaN(limit)) return DEFAULT_TURN_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_TURN_LIMIT);
}

function userText(payload: Record<string, unknown>): string | null {
  const v = payload.user_message;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function replyText(payload: Record<string, unknown>): string | null {
  const v = payload.reply_md;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Returns the most recent Copilot turns, oldest→newest, capped at `limit`
 * (default 20, max 100). Pulls the newest `limit` of both the user-side and
 * reply-side actions, merges by (created_at desc, id desc), keeps the newest
 * `limit`, then reverses to chronological order for the drawer.
 *
 * Rows whose payload has no usable text (corrupt / partial) are dropped — replay
 * is best-effort prefill, never the source of truth.
 */
export async function getRecentCopilotTurns(
  dbArg: DbLike,
  opts: { limit?: number; now?: Date } = {},
): Promise<CopilotTurn[]> {
  const limit = clampLimit(opts.limit);

  // codex #3356884484 — scope replay to the CURRENT reusable Copilot session.
  // Resolve it with the SAME predicate find-or-create uses (shared helper) so a
  // stale prior conversation (ended/abandoned, or last active >24h ago) is never
  // replayed into what the server will treat as a fresh session. No reusable
  // session → this is a brand-new conversation; return nothing to prefill.
  const session = await findReusableCopilotConversation(dbArg as Db, { now: opts.now });
  if (session === null) return [];

  // One query over all three actions for THIS session, newest first, bounded by
  // limit*2 (a turn pair is one user + one reply row, so ≤ limit*2 rows cover
  // `limit` turns). Filter on the events.session_id column — every Copilot turn
  // event (ask/chip + reply) now writes it (the column = the event's conversation
  // session, shared by teaching + copilot; payload.session_id is the portable copy).
  const rows = await dbArg
    .select({
      id: event.id,
      action: event.action,
      payload: event.payload,
      created_at: event.created_at,
    })
    .from(event)
    .where(
      and(
        eq(event.session_id, session.id),
        or(inArray(event.action, [...USER_ACTIONS]), eq(event.action, REPLY_ACTION)),
      ),
    )
    .orderBy(desc(event.created_at), desc(event.id))
    .limit(limit * 2);

  const turns: CopilotTurn[] = [];
  for (const row of rows) {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    if (row.action === REPLY_ACTION) {
      const text = replyText(payload);
      if (text === null) continue;
      turns.push({ role: 'ai', text, at: row.created_at.toISOString(), event_id: row.id });
    } else {
      const text = userText(payload);
      if (text === null) continue;
      turns.push({ role: 'user', text, at: row.created_at.toISOString(), event_id: row.id });
    }
  }

  // rows are newest-first; keep the newest `limit`, then reverse to chronological.
  return turns.slice(0, limit).reverse();
}
