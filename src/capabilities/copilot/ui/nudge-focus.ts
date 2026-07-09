// YUK-577 (Codex P2-1) — one-shot nudge-focus lifecycle, extracted pure so it is unit-testable
// without a CopilotDock render harness. design: docs/design/2026-07-07-yuk577-proactive-triggers.md §3.5.
//
// When a 「看看」click opens the drawer, the nudge's ingestion session becomes the ambient
// focused_entity for the FIRST reply so the agent knows the turn is about that material. It must be
// **one-shot**: consumed by that first turn and cleared on success, so subsequent free-form turns do
// NOT keep re-sending the stale `learning_session` focus for the rest of the drawer session.

export interface AmbientFocus {
  kind: string;
  id: string;
}

/**
 * Ambient focus for a turn: an active skill entity wins; else the nudge's ingestion session (if a
 * 「看看」click seeded one); else none.
 */
export function resolveTurnAmbientFocus(
  skillFocus: AmbientFocus | undefined,
  nudgeSessionId: string | null,
): AmbientFocus | undefined {
  if (skillFocus) return skillFocus;
  if (nudgeSessionId) return { kind: 'learning_session', id: nudgeSessionId };
  return undefined;
}

/**
 * One-shot lifecycle tick for the nudge-session anchor: it is cleared iff the turn SUCCEEDED. A
 * failed turn keeps the anchor so 重试 reuses it (mirrors the one-shot-skill clear rule). Returns the
 * next value of the ref.
 */
export function nextNudgeSessionAfterTurn(
  current: string | null,
  turnSucceeded: boolean,
): string | null {
  return turnSucceeded ? null : current;
}
