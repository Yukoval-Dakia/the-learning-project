// YUK-344 — CorrectEvent attribution relaxation.
//
// CorrectEvent now accepts two authoring lanes:
//   - user lane:  actor_kind='user',  actor_ref='self'  (UI rejudge / correct / revert)
//   - agent lane: actor_kind='agent', actor_ref=<non-'self' ref> (e.g. 'dreaming',
//                 the autonomous nightly edge-reconcile SUPERSEDE)
// The pairing is enforced: 'user' must be 'self', 'agent' must NOT be 'self'. This
// keeps the existing user-correction path intact while letting an autonomous
// supersede be attributed to the agent, not mis-recorded as a user correction.

import { describe, expect, it } from 'vitest';
import { CorrectEvent } from './known';

const basePayload = {
  correction_kind: 'supersede' as const,
  replacement_event_id: 'evt_replacement',
  reason_md: 'superseded a contradicting edge',
  affected_refs: [{ kind: 'question' as const, id: 'q1' }],
};

function row(overrides: Record<string, unknown>) {
  return {
    action: 'correct',
    subject_kind: 'event',
    subject_id: 'evt_target',
    outcome: 'success',
    payload: basePayload,
    ...overrides,
  };
}

describe('CorrectEvent attribution (YUK-344)', () => {
  it('still accepts the user-correction lane (actor_kind=user / actor_ref=self)', () => {
    const parsed = CorrectEvent.safeParse(row({ actor_kind: 'user', actor_ref: 'self' }));
    expect(parsed.success).toBe(true);
  });

  it('now accepts the agent/dreaming lane (actor_kind=agent / actor_ref=dreaming)', () => {
    const parsed = CorrectEvent.safeParse(row({ actor_kind: 'agent', actor_ref: 'dreaming' }));
    expect(parsed.success).toBe(true);
  });

  it('rejects a user correction with a non-self ref (no agent masquerading as user)', () => {
    const parsed = CorrectEvent.safeParse(row({ actor_kind: 'user', actor_ref: 'dreaming' }));
    expect(parsed.success).toBe(false);
  });

  it("rejects an agent correction tagged 'self' (no agent mis-recorded as user)", () => {
    const parsed = CorrectEvent.safeParse(row({ actor_kind: 'agent', actor_ref: 'self' }));
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown actor_kind', () => {
    const parsed = CorrectEvent.safeParse(row({ actor_kind: 'system', actor_ref: 'x' }));
    expect(parsed.success).toBe(false);
  });

  it('still enforces supersede ⇒ replacement_event_id required (both lanes)', () => {
    const agentMissingReplacement = CorrectEvent.safeParse(
      row({
        actor_kind: 'agent',
        actor_ref: 'dreaming',
        payload: { ...basePayload, replacement_event_id: undefined },
      }),
    );
    expect(agentMissingReplacement.success).toBe(false);
  });

  it('accepts a non-supersede correction in the agent lane (retract, no replacement)', () => {
    const parsed = CorrectEvent.safeParse(
      row({
        actor_kind: 'agent',
        actor_ref: 'dreaming',
        payload: {
          correction_kind: 'retract',
          reason_md: 'agent retracted',
          affected_refs: [{ kind: 'question', id: 'q1' }],
        },
      }),
    );
    expect(parsed.success).toBe(true);
  });
});
