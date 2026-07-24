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
import { getCorrectionStatuses } from '@/kernel/events/corrections';
import { findReusableCopilotConversation } from '@/server/session/conversation';
import { and, desc, eq, inArray, ne, or } from 'drizzle-orm';
import { selectAsksWithMaterializingToolCall } from './materializing-tools';

export type CopilotTurnRole = 'user' | 'ai' | 'tombstone';

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
  /** Typed user_ask root that owns this reversible turn. */
  checkpoint_event_id?: string;
  /** Present for AI turns that carried a skill turn (teaching ask_check / explain / end). */
  skill_turn?: CopilotTurnSkillTurn;
  /** Present for AI turns produced by a skill (teaching / solve) — lets replay restore the skill card. */
  skill_context?: CopilotTurnSkillContext;
  /** YUK-307 — present for AI turns whose reply nominated a hero deliverable (§2.3). */
  primary_view?: CopilotPrimaryView;
}

// The ONLY revert root the endpoint accepts (owner-locked). A copilot_chip_trigger is a
// user-role turn but is NOT a revert root, so a reply caused by one must not surface a
// checkpoint_event_id (which would render a revert button that 404s).
const USER_ASK_ACTION = 'experimental:copilot_user_ask';
const USER_ACTIONS = [USER_ASK_ACTION, 'experimental:copilot_chip_trigger'] as const;
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
    // Mirror the emission-side PrimaryViewRefSchema bounds (chat.ts) so the
    // replay narrower can't drift looser than what chat.ts will ever write
    // (PR #375 review LOW-1).
    if (r.kind.length === 0 || r.kind.length > 40) return undefined;
    if (r.id.length === 0 || r.id.length > 120) return undefined;
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
  // YUK-575 (MF-B) — `excludeEventId` drops one event row (by id) from the
  // returned history. The durable copilot run handler passes its own
  // `run_id` (= the user_ask event id) here: unlike the inline path — which
  // reads history BEFORE writing the ask, so the ask is structurally excluded
  // (chat.ts read-before-write) — the durable path DISPATCH writes the user_ask
  // first (api/chat.ts), then the worker picks the job up later, so at pickup
  // time the current ask is already persisted and would otherwise double-count
  // as the newest user turn (and shove out the oldest real turn). Inline callers
  // OMIT this (their read-before-write ordering already excludes the ask); only
  // durable pickup passes it. Absent → byte-identical to the pre-YUK-575 query.
  opts: { limit?: number; now?: Date; excludeEventId?: string } = {},
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
      caused_by_event_id: event.caused_by_event_id,
    })
    .from(event)
    .where(
      and(
        eq(event.session_id, session.id),
        or(inArray(event.action, [...USER_ACTIONS]), eq(event.action, REPLY_ACTION)),
        // YUK-575 (MF-B) — durable pickup excludes its own just-written user_ask
        // by id. `and(…, undefined)` is a drizzle no-op, so omitting it (inline)
        // leaves the query byte-identical.
        opts.excludeEventId ? ne(event.id, opts.excludeEventId) : undefined,
      ),
    )
    .orderBy(desc(event.created_at), desc(event.id))
    .limit(limit * 2);

  // YUK-497 wave-3 (OCR minor) — also probe the retraction status of each reply's parent, even when
  // that parent fell OUTSIDE this limit*2 window. Otherwise a reply whose parent was retracted
  // out-of-window renders normally after a refresh (stale content from a reverted turn). NOTE: a
  // reply's caused_by parent is a user_ask OR a chip_trigger, so this set is NOT ask-only (YUK-497
  // wave-4 rename).
  const replyParentIds = rows
    .filter((row) => row.action === REPLY_ACTION && row.caused_by_event_id)
    .map((row) => row.caused_by_event_id as string);
  const statuses = await getCorrectionStatuses(dbArg, [
    ...new Set([...rows.map((row) => row.id), ...replyParentIds]),
  ]);
  // All typed user-ask ids in the window — the ONLY valid revert roots. A reply's caused_by may be a
  // user_ask OR a chip_trigger; only the former (and in-window) may surface a checkpoint_event_id.
  const askIds = new Set(rows.filter((row) => row.action === USER_ASK_ACTION).map((row) => row.id));
  // Retracted roots include out-of-window parents: a reply under such a parent is skipped (its parent
  // row isn't loaded, so it renders as a hidden skip, not a tombstone) rather than shown stale.
  const retractedParentIds = new Set(
    [...askIds, ...replyParentIds].filter((id) => statuses.get(id)?.state === 'retracted'),
  );
  // YUK-497 wave-4 — asks whose turn called a MATERIALIZING tool (author_question / author_artifact /
  // update_artifact / write_quiz) wrote a domain row cascade-revert can't compensate, so they must
  // NOT re-expose the revert anchor on replay (same rows chat.ts keys the live suppression on).
  const asksWithMaterializingTool = await selectAsksWithMaterializingToolCall(dbArg, [...askIds]);

  const turns: CopilotTurn[] = [];
  for (const row of rows) {
    const checkpointEventId = row.action === USER_ASK_ACTION ? row.id : row.caused_by_event_id;
    if (checkpointEventId && retractedParentIds.has(checkpointEventId)) {
      if (row.id === checkpointEventId) {
        turns.push({
          role: 'tombstone',
          text: '本轮更改已撤回',
          at: row.created_at.toISOString(),
          event_id: row.id,
          checkpoint_event_id: row.id,
        });
      }
      continue;
    }
    if (statuses.get(row.id)?.state === 'retracted') continue;
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
        // Only a reply rooted at a typed user_ask exposes a revert affordance; a
        // chip-triggered reply's caused_by points at a chip_trigger (not a revert root).
        // Anchor exposed ⇔ every effect of the turn is event-chain-compensable (materializing-tools.ts).
        // Suppress it when the turn either (wave-3) materialized a teaching_check draft
        // (skill_turn.structured_question) or (wave-4) called a materializing DOMAIN tool
        // (asksWithMaterializingTool) — both write rows cascade-revert can't undo, so re-exposing the
        // button after a refresh would 409 or orphan the row. Live suppression mirrors this exactly.
        ...(checkpointEventId &&
        askIds.has(checkpointEventId) &&
        !skillTurn?.structured_question &&
        !asksWithMaterializingTool.has(checkpointEventId)
          ? { checkpoint_event_id: checkpointEventId }
          : {}),
      };
      if (skillTurn) turn.skill_turn = skillTurn;
      if (skillContext) turn.skill_context = skillContext;
      if (primaryView) turn.primary_view = primaryView;
      turns.push(turn);
    } else {
      const text = userText(payload);
      if (text === null) continue;
      turns.push({
        role: 'user',
        text,
        at: row.created_at.toISOString(),
        event_id: row.id,
        ...(row.action === USER_ASK_ACTION ? { checkpoint_event_id: row.id } : {}),
      });
    }
  }

  // rows are newest-first; keep the newest `limit`, then reverse to chronological.
  return turns.slice(0, limit).reverse();
}
