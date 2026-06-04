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
});
