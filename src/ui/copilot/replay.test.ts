// AF S3a / YUK-203 U3 — unit test for the pure replay mapping.
//
// The drawer's replay-last-N prefill maps GET /api/copilot/turns → ChatMessage[].
// The unit vitest env is 'node' and @testing-library/react is not installed, so
// the testable seam is this pure function fed a mocked turns array (see
// L-copilot pre-flight缺口表). Drawer fetch wiring is covered by the functional
// dev smoke + the turns db test.

import { describe, expect, it } from 'vitest';
import { type ReplayTurn, replayToMessages } from './replay';

const turn = (over: Partial<ReplayTurn>): ReplayTurn => ({
  role: 'user',
  text: 'hi',
  at: '2026-06-04T00:00:00.000Z',
  event_id: 'ev_1',
  ...over,
});

describe('replayToMessages', () => {
  it('maps user + ai turns to chat messages, preserving order and reusing event_id as the message id', () => {
    const out = replayToMessages([
      turn({ role: 'user', text: '今天该复习哪些？', event_id: 'ask_1' }),
      turn({ role: 'ai', text: '有 3 道题到期。', event_id: 'reply_1' }),
      turn({ role: 'user', text: '解释「之」', event_id: 'ask_2' }),
    ]);
    expect(out).toEqual([
      { id: 'ask_1', role: 'user', text: '今天该复习哪些？' },
      { id: 'reply_1', role: 'ai', text: '有 3 道题到期。' },
      { id: 'ask_2', role: 'user', text: '解释「之」' },
    ]);
  });

  it('drops turns with empty text (best-effort prefill, never SoT)', () => {
    const out = replayToMessages([
      turn({ role: 'user', text: '', event_id: 'ask_empty' }),
      turn({ role: 'ai', text: 'ok', event_id: 'reply_ok' }),
    ]);
    expect(out).toEqual([{ id: 'reply_ok', role: 'ai', text: 'ok' }]);
  });

  it('drops turns with an unknown role', () => {
    const out = replayToMessages([
      // @ts-expect-error — exercising the runtime guard against malformed roles.
      turn({ role: 'system', text: 'nope', event_id: 'ev_sys' }),
      turn({ role: 'user', text: 'yes', event_id: 'ev_user' }),
    ]);
    expect(out).toEqual([{ id: 'ev_user', role: 'user', text: 'yes' }]);
  });

  it('returns [] for an empty turns array (cold start → no prefill)', () => {
    expect(replayToMessages([])).toEqual([]);
  });

  // YUK-272 (C3) — a persisted quiz reply carries skill_context:{skill:'quiz'}.
  // After widening ReplaySkillContext.skill to include 'quiz', it round-trips
  // through replayToMessages without a cast (type-level + runtime forward).
  it('forwards a quiz skill_context through replay without a cast', () => {
    const out = replayToMessages([
      turn({
        role: 'ai',
        text: '[去练习](/practice/art_x)',
        event_id: 'reply_quiz',
        skill_context: { skill: 'quiz', ref: { kind: 'knowledge', id: 'k1' } },
      }),
    ]);
    expect(out).toEqual([
      {
        id: 'reply_quiz',
        role: 'ai',
        text: '[去练习](/practice/art_x)',
        skill_turn: undefined,
        session_id: undefined,
        reply_event_id: undefined,
        skill_context: { skill: 'quiz', ref: { kind: 'knowledge', id: 'k1' } },
      },
    ]);
  });

  // YUK-307 — primary_view (the agent's hero nomination, presentation layer
  // §2.3) is a pure passthrough: forwarded untouched on AI turns that carry it,
  // absent otherwise. replayToMessages does NOT interpret it — rendering policy
  // belongs to the separate UI slice.
  it('forwards primary_view through replay and leaves it absent otherwise', () => {
    const out = replayToMessages([
      turn({
        role: 'ai',
        text: '这是你的题。',
        event_id: 'reply_pv',
        primary_view: { source: 'artifact', ref: { kind: 'question', id: 'q_1' } },
      }),
      turn({
        role: 'ai',
        text: '<div>互动内容</div>',
        event_id: 'reply_pv_html',
        primary_view: { source: 'ephemeral_html', ref: '<div>互动内容</div>' },
      }),
      turn({ role: 'ai', text: '普通回复', event_id: 'reply_plain' }),
    ]);
    expect(out[0]?.primary_view).toEqual({
      source: 'artifact',
      ref: { kind: 'question', id: 'q_1' },
    });
    expect(out[1]?.primary_view).toEqual({ source: 'ephemeral_html', ref: '<div>互动内容</div>' });
    expect(out[2]?.primary_view).toBeUndefined();
  });
});
