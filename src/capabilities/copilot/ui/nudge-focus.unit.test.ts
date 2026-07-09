import { describe, expect, it } from 'vitest';
import { nextNudgeSessionAfterTurn, resolveTurnAmbientFocus } from './nudge-focus';

// YUK-577 (Codex P2-1) — one-shot nudge focus. Guards the regression where the ingestion-session
// anchor stuck across turns: after a successful first turn it must clear, so turn 2 (free-form)
// carries NO stale learning_session focus.

describe('resolveTurnAmbientFocus', () => {
  it('rides the nudge session as a learning_session focus when no skill entity is in scope', () => {
    expect(resolveTurnAmbientFocus(undefined, 'ls_1')).toEqual({
      kind: 'learning_session',
      id: 'ls_1',
    });
  });

  it('lets an active skill entity win over the nudge session', () => {
    const skill = { kind: 'knowledge', id: 'kn_1' };
    expect(resolveTurnAmbientFocus(skill, 'ls_1')).toBe(skill);
  });

  it('is undefined when neither is present', () => {
    expect(resolveTurnAmbientFocus(undefined, null)).toBeUndefined();
  });
});

describe('nextNudgeSessionAfterTurn (one-shot lifecycle)', () => {
  it('CLEARS the anchor after a successful turn (so the next free-form turn carries no stale ref)', () => {
    expect(nextNudgeSessionAfterTurn('ls_1', true)).toBeNull();
  });

  it('KEEPS the anchor after a failed turn (so 重试 reuses it)', () => {
    expect(nextNudgeSessionAfterTurn('ls_1', false)).toBe('ls_1');
  });

  it('is a no-op when there is no anchor', () => {
    expect(nextNudgeSessionAfterTurn(null, true)).toBeNull();
    expect(nextNudgeSessionAfterTurn(null, false)).toBeNull();
  });
});

describe('two-turn regression: nudge focus does not stick', () => {
  it('turn 1 (nudge open, success) consumes+clears; turn 2 carries no focus', () => {
    // Turn 1: 「看看」seeded ls_1; free-form (no skill) → focus rides the session.
    let anchor: string | null = 'ls_1';
    const turn1Focus = resolveTurnAmbientFocus(undefined, anchor);
    expect(turn1Focus).toEqual({ kind: 'learning_session', id: 'ls_1' });
    // Turn 1 succeeds → one-shot clear.
    anchor = nextNudgeSessionAfterTurn(anchor, true);
    expect(anchor).toBeNull();
    // Turn 2: another free-form question → NO stale learning_session focus.
    expect(resolveTurnAmbientFocus(undefined, anchor)).toBeUndefined();
  });
});
