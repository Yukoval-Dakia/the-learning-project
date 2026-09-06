import { projectReplayMessage } from './message-projection';

// Replay owns stable ordering/deduplication of persisted turns. The shared
// message projection validates their presentation metadata just like live replies.

export type ReplayTurnRole = 'user' | 'ai' | 'tombstone';

// Minimal inline types for replayed skill carriers. Mirror their server-side
// counterparts (CopilotSkillContextT, SkillTurn) but are declared here so
// replay.ts stays self-contained and unit-testable without importing the client
// component or the server module.

export interface ReplaySkillTurn {
  kind: 'explain' | 'ask_check' | 'end';
  structured_question?: {
    id: string;
    kind: string;
    prompt_md: string;
    choices_md: string[] | null;
  };
  suggested_next?: 'continue' | 'end';
}

// AF S4 / YUK-203 U6 (round-2) — the originating skill selector that produced
// this AI turn. Present on AI turns that carried a skill_context in the chat
// request. CopilotDock restores activeSkillRef from this field on replay so
// composer answers after a page refresh still route to the teaching/solve skill.
export interface ReplaySkillContext {
  // Legacy solve turns still round-trip. Mode lifetime is determined by the
  // explicit skill_turn state, never by membership in this compatibility union.
  skill: 'teaching' | 'solve' | 'quiz';
  ref: { kind: string; id: string };
}

// YUK-307 — the agent-nominated hero deliverable persisted on a reply turn
// (presentation layer §2.3). Mirrors CopilotPrimaryView (src/capabilities/copilot/server/
// turns.ts), declared inline so replay.ts stays self-contained (same precedent
// as ReplaySkillTurn / ReplaySkillContext above). replayToMessages forwards it
// untouched; RENDERING the nomination (hero card density / Dock policy) is the
// separate UI slice — nothing here interprets the field.
export type ReplayPrimaryView =
  | { source: 'tool_result' | 'artifact'; ref: { kind: string; id: string } }
  | { source: 'ephemeral_html'; ref: string };

export interface ReplayTurn {
  role: ReplayTurnRole;
  text: string;
  at: string;
  event_id: string;
  checkpoint_event_id?: string;
  // AF S4 / YUK-203 U6 — present on AI turns that carried a skill result.
  skill_turn?: ReplaySkillTurn;
  session_id?: string;
  reply_event_id?: string;
  // AF S4 / YUK-203 U6 (round-2) — the skill_context that produced this turn.
  skill_context?: ReplaySkillContext;
  // YUK-307 — present on AI turns whose reply nominated a hero deliverable.
  primary_view?: ReplayPrimaryView;
  // YUK-457 — present on AI turns whose parent emitted tool_use mirror events.
  tool_calls?: ReplayToolCall[];
  tool_operations?: ReplayToolOperation[];
  subagent_runs?: ReplaySubagentRun[];
}

export interface ReplayChatMessage {
  id: string;
  role: 'user' | 'ai' | 'tombstone';
  text: string;
  checkpoint_event_id?: string;
  // AF S4 / YUK-203 U6 — propagated from the turns API so skill cards survive
  // drawer reopen / page refresh.
  skill_turn?: ReplaySkillTurn;
  session_id?: string;
  reply_event_id?: string;
  // AF S4 / YUK-203 U6 (round-2) — forwarded so CopilotDock can restore
  // activeSkillRef by folding explicit state, including end barriers, on replay.
  skill_context?: ReplaySkillContext;
  // YUK-307 — forwarded so the (future) UI slice can restore the hero
  // nomination on replay; pure passthrough, zero rendering here.
  primary_view?: ReplayPrimaryView;
  // YUK-457 — forwarded so tool-use cards survive drawer reopen / page refresh.
  tool_calls?: ReplayToolCall[];
  tool_operations?: ReplayToolOperation[];
  subagent_runs?: ReplaySubagentRun[];
}

/** YUK-457 — replay projection of a persisted tool_use mirror. */
export interface ReplayToolCall {
  toolName: string;
  input: Record<string, unknown>;
  summary?: string;
  errorReason?: string;
  status: 'done' | 'failed';
}

export interface ReplayToolOperation {
  id: string;
  tool_name: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'lost';
}

export interface ReplaySubagentRun {
  id: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'lost';
}

/**
 * Maps the GET /api/copilot/turns response (oldest→newest) into the drawer's
 * ChatMessage list. The turn's event_id is reused as the stable message id
 * (replayed messages are addressable; live messages keep their nextId()). Empty
 * / malformed turns (no text) are dropped — replay is best-effort prefill.
 * Skill-turn fields are validated by the shared reply projection when present.
 */
export function replayToMessages(turns: ReplayTurn[]): ReplayChatMessage[] {
  const out: ReplayChatMessage[] = [];
  const seenEventIds = new Set<string>();
  for (const turn of turns) {
    if (turn.role !== 'user' && turn.role !== 'ai' && turn.role !== 'tombstone') continue;
    if (seenEventIds.has(turn.event_id)) continue;
    const message = projectReplayMessage(turn);
    if (!message) continue;
    seenEventIds.add(turn.event_id);
    out.push(message);
  }
  return out;
}
