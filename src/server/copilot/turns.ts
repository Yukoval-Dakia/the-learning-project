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

// AF S4 / YUK-203 U6 (PR #305 review comment #2) — skill_turn is persisted in
// the copilot_reply event payload so replay can surface the structured question
// card without re-running the LLM. Shape mirrors CopilotSkillTurn in chat.ts;
// kept here as a plain interface to avoid circular imports.
export interface CopilotTurnSkillTurn {
  kind: 'explain' | 'ask_check' | 'end';
  structured_question?: {
    id: string;
    kind: string;
    prompt_md: string;
    choices_md: string[] | null;
  };
  suggested_next?: 'continue' | 'end';
}

// PR round-2 — skill_context persisted in copilot_reply payload so replay can
// restore the skill card even after page refresh (without re-running the LLM).
export interface CopilotTurnSkillContext {
  skill: string;
  ref: { kind: string; id: string };
}

// YUK-307 (presentation layer §2.3, RULED) — the agent-nominated hero deliverable
// for one reply turn: `primary_view?: { source: 'tool_result' | 'artifact' |
// 'ephemeral_html', ref }`. Persisted as an ADDITIVE field on the copilot_reply
// payload so Dock replay can restore the hero nomination (ADR-0033 D5:
// primary_view:{source:'artifact', ref} opens the reference card). Plain types
// live here (the zod parse schema lives at the extraction point in chat.ts —
// same import direction as CopilotTurnSkillTurn: chat.ts → turns.ts, never back).
export const PRIMARY_VIEW_SOURCES = ['tool_result', 'artifact', 'ephemeral_html'] as const;
export type PrimaryViewSource = (typeof PRIMARY_VIEW_SOURCES)[number];
// Bound for the ephemeral_html inline carrier so the jsonb payload stays bounded.
export const EPHEMERAL_HTML_REF_MAX_CHARS = 32_000;
export type CopilotPrimaryView =
  | { source: 'tool_result' | 'artifact'; ref: { kind: string; id: string } }
  // PHASE-DEFERRED (UI slice): for ephemeral_html the ref string IS the inline
  // HTML body (the carrier is the content — there is no persisted row to point
  // at). If the UI slice rules a different carrier (e.g. a reply_md html-block
  // reference), this is the single place to re-anchor; see the presentation
  // design doc §2.5 (docs/design/2026-06-09-copilot-presentation-layer.md).
  | { source: 'ephemeral_html'; ref: string };

export interface CopilotTurn {
  role: CopilotTurnRole;
  text: string;
  at: string; // ISO timestamp
  event_id: string;
  // PR round-2 (CR 3360614432): session_id + reply_event_id let the Dock
  // chip-renderer anchor a corrective chip on the correct event/session after
  // page refresh. session_id = the Copilot conversation envelope id; both are
  // present only on AI turns (replay fills them from the event row).
  session_id?: string;
  reply_event_id?: string;
  /** Present for AI turns that carried a skill turn (teaching ask_check / explain / end). */
  skill_turn?: CopilotTurnSkillTurn;
  /** Present for AI turns produced by a skill (teaching / solve) — lets replay restore the skill card. */
  skill_context?: CopilotTurnSkillContext;
  /** YUK-307 — present for AI turns whose reply nominated a hero deliverable (§2.3). */
  primary_view?: CopilotPrimaryView;
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

function replySkillTurn(payload: Record<string, unknown>): CopilotTurnSkillTurn | undefined {
  const st = payload.skill_turn;
  if (!st || typeof st !== 'object') return undefined;
  const s = st as Record<string, unknown>;
  const kind = s.kind;
  if (kind !== 'explain' && kind !== 'ask_check' && kind !== 'end') return undefined;
  // Narrow the shape to what the UI needs; extra fields pass through.
  const result: CopilotTurnSkillTurn = { kind };
  if (s.suggested_next === 'continue' || s.suggested_next === 'end') {
    result.suggested_next = s.suggested_next;
  }
  if (s.structured_question && typeof s.structured_question === 'object') {
    const sq = s.structured_question as Record<string, unknown>;
    if (
      typeof sq.id === 'string' &&
      typeof sq.kind === 'string' &&
      typeof sq.prompt_md === 'string'
    ) {
      // PR round-2 (CR 3360606340): validate every element is a string before
      // passing through; a corrupt array (e.g. [{text:'...'}]) becomes null.
      const rawChoices = sq.choices_md;
      const choices_md =
        Array.isArray(rawChoices) && rawChoices.every((el) => typeof el === 'string')
          ? (rawChoices as string[])
          : null;
      result.structured_question = {
        id: sq.id,
        kind: sq.kind,
        prompt_md: sq.prompt_md,
        choices_md,
      };
    }
  }
  return result;
}

// YUK-307 — hand-rolled narrower mirroring replySkillContext (turns.ts stays
// zod-free; the strict parse lives at the emission point in chat.ts). Any shape
// that does not match one of the three ruled source variants → undefined (the
// turn is still returned — replay is best-effort prefill, never the SoT).
function replyPrimaryView(payload: Record<string, unknown>): CopilotPrimaryView | undefined {
  const pv = payload.primary_view;
  if (!pv || typeof pv !== 'object') return undefined;
  const p = pv as Record<string, unknown>;
  const source = p.source;
  if (source === 'tool_result' || source === 'artifact') {
    const ref = p.ref;
    if (!ref || typeof ref !== 'object') return undefined;
    const r = ref as Record<string, unknown>;
    if (typeof r.kind !== 'string' || typeof r.id !== 'string') return undefined;
    return { source, ref: { kind: r.kind, id: r.id } };
  }
  if (source === 'ephemeral_html') {
    const ref = p.ref;
    if (typeof ref !== 'string' || ref.length === 0 || ref.length > EPHEMERAL_HTML_REF_MAX_CHARS) {
      return undefined;
    }
    return { source, ref };
  }
  return undefined;
}

function replySkillContext(payload: Record<string, unknown>): CopilotTurnSkillContext | undefined {
  const sc = payload.skill_context;
  if (!sc || typeof sc !== 'object') return undefined;
  const s = sc as Record<string, unknown>;
  if (typeof s.skill !== 'string') return undefined;
  const ref = s.ref;
  if (!ref || typeof ref !== 'object') return undefined;
  const r = ref as Record<string, unknown>;
  if (typeof r.kind !== 'string' || typeof r.id !== 'string') return undefined;
  return { skill: s.skill, ref: { kind: r.kind, id: r.id } };
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
      const skillTurn = replySkillTurn(payload);
      const skillContext = replySkillContext(payload);
      const primaryView = replyPrimaryView(payload);
      const turn: CopilotTurn = {
        role: 'ai',
        text,
        at: row.created_at.toISOString(),
        event_id: row.id,
        // PR round-2 (CR 3360614432): Dock chip renderer needs session_id to
        // resolve the conversation and reply_event_id to anchor the chip.
        session_id: session.id,
        reply_event_id: row.id,
      };
      if (skillTurn) turn.skill_turn = skillTurn;
      if (skillContext) turn.skill_context = skillContext;
      if (primaryView) turn.primary_view = primaryView;
      turns.push(turn);
    } else {
      const text = userText(payload);
      if (text === null) continue;
      turns.push({ role: 'user', text, at: row.created_at.toISOString(), event_id: row.id });
    }
  }

  // rows are newest-first; keep the newest `limit`, then reverse to chronological.
  return turns.slice(0, limit).reverse();
}
