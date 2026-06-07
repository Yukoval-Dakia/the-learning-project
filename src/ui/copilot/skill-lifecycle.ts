// YUK-272 (C3) — Copilot skill lifecycle helper (pure, no DOM).
//
// The Dock clears its active skill context on a teaching `end` turn. But quiz is a
// ONE-SHOT skill: it returns NO terminal `skill_turn` (chat.ts quiz service-action
// path), so the `end`-turn clear never fires for it. Without this guard every
// follow-up free-form message after a quiz would keep re-sending the stale
// skill_context (the YUK-213 F2 one-shot-stuck bug).
//
// The one-shot decision is extracted here as a pure function so it is unit-testable
// without a DOM (the repo's unit env is `node` with no jsdom/@testing-library — see
// replay.ts). The Dock imports isOneShotSkill and clears activeSkillRef after a
// successful one-shot send. The server-side skill_turn redesign (emit a terminal
// turn for one-shot skills) is owned by YUK-213; this is the Dock-only minimal fix.

// The skills that complete in a single turn and return no terminal skill_turn.
// teaching is NOT here — it is multi-turn and clears on its own `end` turn.
// YUK-284 (C3) — `solve` removed: it has NO UI seed (no chip ever produces
// skill_context:{skill:'solve'}), so activeSkillRef never becomes {skill:'solve'} and
// keeping it here was dead config. quiz stays (chip quiz still seeds {skill:'quiz'}).
export const ONE_SHOT_SKILLS = new Set(['quiz']);

export function isOneShotSkill(skill: string): boolean {
  return ONE_SHOT_SKILLS.has(skill);
}
