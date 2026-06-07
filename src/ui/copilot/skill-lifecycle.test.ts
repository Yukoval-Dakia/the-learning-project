// YUK-272 (C3) — pure unit for the one-shot-skill lifecycle rule. Lives under
// src/ui/ so it is auto-allowlisted into the unit partition by the
// src/ui/**/*.test.ts(x) glob (no manual fastTestInclude edit). No DOM needed.

import { describe, expect, it } from 'vitest';
import { ONE_SHOT_SKILLS, isOneShotSkill } from './skill-lifecycle';

describe('isOneShotSkill (YUK-272 / YUK-213 F2)', () => {
  it('treats quiz + solve as one-shot (they return no terminal skill_turn)', () => {
    expect(isOneShotSkill('quiz')).toBe(true);
    expect(isOneShotSkill('solve')).toBe(true);
  });

  it('does NOT treat teaching as one-shot (it clears on its own end turn)', () => {
    expect(isOneShotSkill('teaching')).toBe(false);
  });

  it('returns false for unknown / empty skill names', () => {
    expect(isOneShotSkill('')).toBe(false);
    expect(isOneShotSkill('nonsense')).toBe(false);
  });

  it('ONE_SHOT_SKILLS is exactly { quiz, solve }', () => {
    expect([...ONE_SHOT_SKILLS].sort()).toEqual(['quiz', 'solve']);
  });
});
