// YUK-272 (C3) — pure unit for the one-shot-skill lifecycle rule. Lives under
// src/capabilities/copilot/ui/ (M5-T3 / YUK-321 — moved from src/ui/copilot/) and is
// auto-allowlisted into the unit partition by the src/capabilities/**/*.unit.test.ts
// convention glob (no manual fastTestInclude edit). No DOM needed.

import { describe, expect, it } from 'vitest';
import { ONE_SHOT_SKILLS, isOneShotSkill } from './skill-lifecycle';

describe('isOneShotSkill (YUK-272 / YUK-213 F2)', () => {
  it('treats quiz as one-shot (it returns no terminal skill_turn)', () => {
    expect(isOneShotSkill('quiz')).toBe(true);
  });

  // YUK-284 (C3) — solve is no longer one-shot config: it has no UI seed, so
  // activeSkillRef never becomes {skill:'solve'}. It was removed from ONE_SHOT_SKILLS.
  it('does NOT treat solve as one-shot (no UI seed → dead config removed)', () => {
    expect(isOneShotSkill('solve')).toBe(false);
  });

  it('does NOT treat teaching as one-shot (it clears on its own end turn)', () => {
    expect(isOneShotSkill('teaching')).toBe(false);
  });

  it('returns false for unknown / empty skill names', () => {
    expect(isOneShotSkill('')).toBe(false);
    expect(isOneShotSkill('nonsense')).toBe(false);
  });

  it('ONE_SHOT_SKILLS is exactly { quiz }', () => {
    expect([...ONE_SHOT_SKILLS].sort()).toEqual(['quiz']);
  });
});
