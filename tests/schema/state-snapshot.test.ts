import { ExperimentalEvent, parseEvent } from '@/core/schema/event';
import { StateSnapshotExperimental } from '@/core/schema/event/state-snapshot';
import { describe, expect, it } from 'vitest';

// ====================================================================
// StateSnapshotExperimental — A-class snapshot reversibility (YUK-471 Wave 0)
// ====================================================================
//
// HARD REQ 1 (ADR-0044): a dedicated `StateSnapshotExperimental` Zod schema
// validated by writeEvent's parseEvent barrier — NOT the loose generic
// ExperimentalEvent fallback. These tests prove the parse barrier bites.
//
// Grounding: w0-PLAN.md §4.A (tests 1-7). actor_kind pinned to 'system' per
// plan §6.3 (internal rollback ledger row, not an agent action).

// A well-formed FsrsState (matches FsrsStateSchema in ./blocks.ts:68).
const validFsrsState = {
  due: '2026-07-01T00:00:00.000Z',
  stability: 1.5,
  difficulty: 0.2,
  elapsed_days: 0,
  scheduled_days: 1,
  learning_steps: 2,
  reps: 1,
  lapses: 0,
  state: 'learning',
  last_review: '2026-06-23T00:00:00.000Z',
};

// A complete, well-formed StateSnapshotExperimental payload (theta + fsrs
// arrays, before mix of null/number, FSRS before=null cold-start).
const validSnapshot = {
  actor_kind: 'system',
  actor_ref: 'attempt_snapshot',
  action: 'experimental:state_snapshot',
  subject_kind: 'event',
  subject_id: 'evt_attempt_001',
  outcome: 'success',
  payload: {
    attempt_event_id: 'evt_attempt_001',
    theta_snapshots: [
      { kc_id: 'kc_a', before: null, after: 0.42 }, // cold-start KC (before=null)
      { kc_id: 'kc_b', before: -0.1, after: 0.05 }, // existing KC (prior θ̂)
    ],
    fsrs_snapshots: [
      {
        subject_kind: 'question',
        subject_id: 'q_1',
        before: null, // cold-start subject
        after: validFsrsState,
      },
    ],
  },
  caused_by_event_id: 'evt_attempt_001',
};

describe('StateSnapshotExperimental — parse barrier (HARD REQ 1)', () => {
  it('1. valid payload parses through top-level parseEvent', () => {
    // A well-formed snapshot routes to the dedicated branch (not generic).
    const parsed = parseEvent(validSnapshot);
    // Proves it parsed as the dedicated schema (action literal is preserved
    // and discriminates from the generic ExperimentalEvent fallback which
    // would also accept arbitrary payloads).
    expect(parsed.action).toBe('experimental:state_snapshot');
    // Narrow off the structured shape: the dedicated schema has actor_kind +
    // a typed payload, whereas the generic ExperimentalEvent fallback (action:
    // string, payload: Record<string, unknown>) does not. `actor_kind in parsed`
    // proves the value routed to the dedicated branch, not the loose generic.
    if ('actor_kind' in parsed && 'theta_snapshots' in parsed.payload) {
      expect(parsed.actor_kind).toBe('system');
      expect(parsed.payload.theta_snapshots).toHaveLength(2);
      expect(parsed.payload.fsrs_snapshots).toHaveLength(1);
    } else {
      // If we land here the value fell through to the generic fallback — fail
      // loudly (this would mean union precedence regressed).
      throw new Error('snapshot did not route to the dedicated schema branch');
    }
  });

  it('2. missing theta_snapshots rejected (reserved action, no generic fallback)', () => {
    // Payload without theta_snapshots must throw — the generic fallback must
    // NOT swallow it because the action is reserved.
    const { theta_snapshots: _omit, ...payloadNoTheta } = validSnapshot.payload;
    const malformed = { ...validSnapshot, payload: payloadNoTheta };
    expect(() => parseEvent(malformed)).toThrow();
    // Belt-and-braces: the dedicated schema itself rejects.
    const result = StateSnapshotExperimental.safeParse(malformed);
    expect(result.success).toBe(false);
  });

  it('3. malformed theta entry rejected (after missing / before a string)', () => {
    // theta_snapshots[].after missing -> throws.
    const malformedAfterMissing = {
      ...validSnapshot,
      payload: {
        ...validSnapshot.payload,
        theta_snapshots: [{ kc_id: 'kc_a', before: null }], // after missing
      },
    };
    expect(() => parseEvent(malformedAfterMissing)).toThrow();

    // theta_snapshots[].before a string (not number|null) -> throws.
    const malformedBeforeString = {
      ...validSnapshot,
      payload: {
        ...validSnapshot.payload,
        theta_snapshots: [{ kc_id: 'kc_a', before: 'zero', after: 0.1 }],
      },
    };
    expect(() => parseEvent(malformedBeforeString)).toThrow();
  });

  it('4. malformed FsrsState rejected (after missing stability/due)', () => {
    // fsrs_snapshots[].after missing `stability` and `due` -> throws.
    // Proves the FsrsStateSchema reuse bites (not a loose record).
    const { stability: _s, due: _d, ...badFsrsState } = validFsrsState;
    const malformed = {
      ...validSnapshot,
      payload: {
        ...validSnapshot.payload,
        fsrs_snapshots: [
          {
            subject_kind: 'question',
            subject_id: 'q_1',
            before: null,
            after: badFsrsState,
          },
        ],
      },
    };
    expect(() => parseEvent(malformed)).toThrow();
  });

  it('5. before=null allowed for both segments (cold-start)', () => {
    // Both theta.before=null and fsrs.before=null parse OK (cold-start rows).
    const coldStart = {
      ...validSnapshot,
      payload: {
        attempt_event_id: 'evt_attempt_001',
        theta_snapshots: [{ kc_id: 'kc_c', before: null, after: 0.3 }],
        fsrs_snapshots: [
          {
            subject_kind: 'knowledge',
            subject_id: 'k_1',
            before: null,
            after: validFsrsState,
          },
        ],
      },
    };
    const parsed = parseEvent(coldStart);
    expect(parsed.action).toBe('experimental:state_snapshot');
  });

  it("6. generic ExperimentalEvent rejects reserved action 'experimental:state_snapshot'", () => {
    // A payload with the reserved action + loose payload:{} must throw via
    // ExperimentalEvent's refine(!RESERVED…) — proves RESERVED set wiring
    // AND union precedence (without precedence the loose record would match
    // the generic branch first and silently pass).
    const result = ExperimentalEvent.safeParse({
      action: 'experimental:state_snapshot',
      payload: {},
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/reserved experimental action/);
    }
  });

  it('7. unrelated experimental:* still parses via generic (regression)', () => {
    // experimental:foo with a record payload still passes through the generic
    // fallback — we did not break the escape hatch by reserving state_snapshot.
    const parsed = parseEvent({
      action: 'experimental:foo',
      payload: { any: 'thing', n: 1 },
    });
    expect(parsed.action).toBe('experimental:foo');
  });
});
