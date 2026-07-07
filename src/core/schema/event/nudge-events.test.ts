import { describe, expect, it } from 'vitest';
import { type EventT, parseEvent } from './index';

// ====================================================================
// YUK-577 copilot_nudge parse-barrier tests (design §3.3, should#2).
//
// parseEvent (Event.parse) routes `experimental:copilot_nudge` to the dedicated typed
// NudgeExperimental schema (./nudge-events.ts), NOT the loose generic ExperimentalEvent.
// The event is承重 (GET /nudges reads it + 频控/surfacing gate depend on payload 承重键),
// so a malformed payload MUST fail loud at the barrier — never silently fall through to a
// loose record. The two lightweight companion actions (_dismissed / _opened) are intentionally
// NOT reserved and DO parse via the generic hatch.
//
// No DB / no IO — pure schema parsing.
// ====================================================================

function nudgeEvent(
  overPayload: Record<string, unknown> = {},
  overTop: Record<string, unknown> = {},
) {
  return {
    actor_kind: 'agent',
    actor_ref: 'copilot_nudge_trigger',
    action: 'experimental:copilot_nudge',
    subject_kind: 'learning_session',
    subject_id: 'sess_1',
    caused_by_event_id: 'evt_extract_1',
    payload: {
      kind: 'ingestion_complete',
      headline: '我处理完《期中卷》，提取到 12 个题目片段',
      expires_at: '2026-07-08T00:00:00.000Z',
      shadow: true,
      in_active_session: false,
      evidence: { session_id: 'sess_1', block_count: 12 },
      ...overPayload,
    },
    ...overTop,
  };
}

describe('NudgeExperimental parse barrier', () => {
  it('routes a well-formed copilot_nudge to the typed schema (not the generic hatch)', () => {
    const parsed = parseEvent(nudgeEvent()) as Extract<
      EventT,
      { action: 'experimental:copilot_nudge' }
    >;
    expect(parsed.action).toBe('experimental:copilot_nudge');
    // Typed schema preserves承重键 (a generic record would keep them too, but the point is it
    // resolved to the SPECIFIC branch — assert the discriminated shape is available).
    expect(parsed.payload.kind).toBe('ingestion_complete');
    expect(parsed.payload.shadow).toBe(true);
    expect(parsed.payload.in_active_session).toBe(false);
  });

  it('parses a knowledge-subject (cut-2 streak) nudge shape', () => {
    const ev = nudgeEvent(
      { kind: 'kc_wrong_streak', evidence: { kc_id: 'kn_1', streak_n: 3 } },
      { subject_kind: 'knowledge', subject_id: 'kn_1' },
    );
    expect(() => parseEvent(ev)).not.toThrow();
  });

  it('FAILS LOUD when a承重键 is missing (headline) — never falls through to generic', () => {
    const bad = nudgeEvent();
    // biome-ignore lint/performance/noDelete: test needs the key genuinely absent
    delete (bad.payload as Record<string, unknown>).headline;
    expect(() => parseEvent(bad)).toThrow();
  });

  it('FAILS LOUD when shadow gate key is missing', () => {
    const bad = nudgeEvent();
    // biome-ignore lint/performance/noDelete: test needs the key genuinely absent
    delete (bad.payload as Record<string, unknown>).shadow;
    expect(() => parseEvent(bad)).toThrow();
  });

  it('FAILS LOUD when caused_by_event_id (evidence anchor + unique key) is missing', () => {
    const bad = nudgeEvent();
    // biome-ignore lint/performance/noDelete: test needs the key genuinely absent
    delete (bad as Record<string, unknown>).caused_by_event_id;
    expect(() => parseEvent(bad)).toThrow();
  });

  it('FAILS LOUD on wrong actor_ref (reserved action cannot masquerade)', () => {
    const bad = nudgeEvent({}, { actor_ref: 'not_the_trigger' });
    expect(() => parseEvent(bad)).toThrow();
  });

  it('dismiss / opened companion actions parse via the generic hatch (not reserved)', () => {
    const dismissed = {
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'experimental:copilot_nudge_dismissed',
      subject_kind: 'event',
      subject_id: 'evt_nudge_1',
      caused_by_event_id: 'evt_nudge_1',
      payload: {},
    };
    const opened = { ...dismissed, action: 'experimental:copilot_nudge_opened' };
    expect(() => parseEvent(dismissed)).not.toThrow();
    expect(() => parseEvent(opened)).not.toThrow();
  });
});
