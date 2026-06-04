// AF S3a / YUK-203 U3 — pure replay mapping for CopilotDock.
//
// The drawer prefills its in-memory message list from GET /api/copilot/turns on
// open (replay-last-N). The mapping from the turns API shape to the drawer's
// ChatMessage shape is extracted here as a pure function so it is unit-testable
// without jsdom / @testing-library (the unit vitest env is 'node' and neither is
// installed — see L-copilot pre-flight缺口表). The drawer imports replayToMessages
// and feeds it the fetched turns; on fetch failure it skips replay (stays on the
// current in-memory list — graceful degradation to pre-S3a behaviour).

export type ReplayTurnRole = 'user' | 'ai';

export interface ReplayTurn {
  role: ReplayTurnRole;
  text: string;
  at: string;
  event_id: string;
}

export interface ReplayChatMessage {
  id: string;
  role: 'user' | 'ai';
  text: string;
}

/**
 * Maps the GET /api/copilot/turns response (oldest→newest) into the drawer's
 * ChatMessage list. The turn's event_id is reused as the stable message id
 * (replayed messages are addressable; live messages keep their nextId()). Empty
 * / malformed turns (no text) are dropped — replay is best-effort prefill.
 */
export function replayToMessages(turns: ReplayTurn[]): ReplayChatMessage[] {
  const out: ReplayChatMessage[] = [];
  for (const t of turns) {
    if (typeof t.text !== 'string' || t.text.length === 0) continue;
    if (t.role !== 'user' && t.role !== 'ai') continue;
    out.push({ id: t.event_id, role: t.role, text: t.text });
  }
  return out;
}
