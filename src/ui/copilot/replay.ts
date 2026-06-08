// AF S3a / YUK-203 U3 — pure replay mapping for CopilotDock.
//
// The drawer prefills its in-memory message list from GET /api/copilot/turns on
// open (replay-last-N). The mapping from the turns API shape to the drawer's
// ChatMessage shape is extracted here as a pure function so it is unit-testable
// without jsdom / @testing-library (the unit vitest env is 'node' and neither is
// installed — see L-copilot pre-flight缺口表). The drawer imports replayToMessages
// and feeds it the fetched turns; on fetch failure it skips replay (stays on the
// current in-memory list — graceful degradation to pre-S3a behaviour).
//
// AF S4 / YUK-203 U6 (PR #305) — AI turns from GET /api/copilot/turns now carry
// optional skill_turn, session_id, and reply_event_id fields (backend additive
// extension). replayToMessages transparently propagates them so ask_check cards
// and corrective chips re-appear after a drawer reopen / page refresh.

export type ReplayTurnRole = 'user' | 'ai';

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
  // YUK-272 (C3) — widened to include 'quiz' so a persisted quiz reply
  // (chat.ts writes skill_context:{skill:'quiz'}) round-trips through replay
  // without an `as` cast. Type-only; replayToMessages forwards the field
  // untouched. Because C3 clears activeSkillRef immediately for one-shot quiz, the
  // replay-restore effect never restores quiz context (a quiz turn carries no
  // skill_turn, so CopilotDock's restore guard skips it).
  //
  // YUK-284 (C3) — 'solve' is KEPT in the union for backward compatibility: solve was
  // extracted from the skill_context protocol (chat.ts no longer routes it), but a
  // persisted-old solve reply may still carry skill_context:{skill:'solve'} and must
  // round-trip through replay without a cast. A solve reply carries no skill_turn, so
  // (like quiz) CopilotDock's restore guard never restores solve context.
  skill: 'teaching' | 'solve' | 'quiz';
  ref: { kind: string; id: string };
}

export interface ReplayTurn {
  role: ReplayTurnRole;
  text: string;
  at: string;
  event_id: string;
  // AF S4 / YUK-203 U6 — present on AI turns that carried a skill result.
  skill_turn?: ReplaySkillTurn;
  session_id?: string;
  reply_event_id?: string;
  // AF S4 / YUK-203 U6 (round-2) — the skill_context that produced this turn.
  skill_context?: ReplaySkillContext;
}

export interface ReplayChatMessage {
  id: string;
  role: 'user' | 'ai';
  text: string;
  // AF S4 / YUK-203 U6 — propagated from the turns API so skill cards survive
  // drawer reopen / page refresh.
  skill_turn?: ReplaySkillTurn;
  session_id?: string;
  reply_event_id?: string;
  // AF S4 / YUK-203 U6 (round-2) — forwarded so CopilotDock can restore
  // activeSkillRef from the last non-end skill turn on replay.
  skill_context?: ReplaySkillContext;
}

/**
 * Maps the GET /api/copilot/turns response (oldest→newest) into the drawer's
 * ChatMessage list. The turn's event_id is reused as the stable message id
 * (replayed messages are addressable; live messages keep their nextId()). Empty
 * / malformed turns (no text) are dropped — replay is best-effort prefill.
 * Skill-turn fields are transparently forwarded when present.
 */
export function replayToMessages(turns: ReplayTurn[]): ReplayChatMessage[] {
  const out: ReplayChatMessage[] = [];
  for (const t of turns) {
    if (typeof t.text !== 'string' || t.text.length === 0) continue;
    if (t.role !== 'user' && t.role !== 'ai') continue;
    out.push({
      id: t.event_id,
      role: t.role,
      text: t.text,
      skill_turn: t.skill_turn,
      session_id: t.session_id,
      reply_event_id: t.reply_event_id,
      skill_context: t.skill_context,
    });
  }
  return out;
}
