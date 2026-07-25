// YUK-777 A2 — the parse barrier for `experimental:judge_pending_attempt`.
//
// This action is RESERVED, which is the only reason a malformed payload fails loudly instead
// of sliding through the generic `experimental:*` hatch as a loose record. That matters more
// here than for a report-only ledger: the payload is what the reconcile sweeper re-enqueues
// and what the late-arrival guard reads as a water mark, so a row that lost its shape would
// strand a real learner answer with nothing left to recover it from.

import { describe, expect, it } from 'vitest';
import { parseEvent } from './index';
import { JudgePendingAttemptExperimental } from './judge-pending-events';

const validEvent = () => ({
  actor_kind: 'user' as const,
  actor_ref: 'self',
  action: 'experimental:judge_pending_attempt',
  subject_kind: 'question' as const,
  subject_id: 'q_1',
  outcome: null,
  payload: {
    run_id: 'run_1',
    caller: 'submit',
    knowledge_ids: ['k1'],
    submit: {
      body: { question_id: 'q_1', rating: 'good' },
      question_id: 'q_1',
      subject_profile: { subject: 'wenyan' },
      question_snapshot: { kind: 'short_answer', prompt_md: 'p' },
      submitted_at: '2026-07-25T00:00:00.000Z',
    },
  },
});

describe('JudgePendingAttemptExperimental', () => {
  it('parses through the TYPED branch, not the loose experimental hatch', () => {
    const parsed = parseEvent(validEvent());
    // The generic hatch keeps only `{action, payload}`. Seeing the envelope back proves the
    // dedicated schema won the union race — i.e. the ordering in ./index.ts is right.
    expect(parsed).toMatchObject({
      actor_kind: 'user',
      subject_kind: 'question',
      subject_id: 'q_1',
      payload: { run_id: 'run_1', caller: 'submit' },
    });
    expect(JudgePendingAttemptExperimental.safeParse(validEvent()).success).toBe(true);
  });

  it('rejects a payload missing the re-enqueue inputs the sweeper needs', () => {
    for (const drop of ['run_id', 'caller', 'knowledge_ids', 'submit'] as const) {
      const bad = validEvent();
      delete (bad.payload as Record<string, unknown>)[drop];
      expect(() => parseEvent(bad), `dropping ${drop} must fail the barrier`).toThrow();
    }
  });

  it('rejects a frozen judge input that lost its shape', () => {
    const bad = validEvent();
    // A string where the frozen body belongs: the worker would re-parse it, fail deep inside
    // the judge, and burn the whole redelivery budget on a permanent defect. Catching it at
    // the boundary is what makes it classifiable as `invalid_payload`.
    (bad.payload.submit as Record<string, unknown>).body = 'not-an-object';
    expect(() => parseEvent(bad)).toThrow();

    const badStamp = validEvent();
    // `submitted_at` is the ordering water mark AND the FSRS scheduling anchor. A stamp that
    // does not parse would silently become an Invalid Date downstream.
    (badStamp.payload.submit as Record<string, unknown>).submitted_at = 'yesterday';
    expect(() => parseEvent(badStamp)).toThrow();
  });

  it('rejects an outcome — an unjudged attempt has none, and that absence is load-bearing', () => {
    const bad = { ...validEvent(), outcome: 'success' };
    // If this row could carry an outcome it would start looking like a judged attempt to
    // anything that grew a habit of reading `outcome`, which is exactly the double-count the
    // separate action name exists to prevent.
    expect(() => parseEvent(bad)).toThrow();
  });

  it('is NOT reachable through the generic experimental hatch', () => {
    // Same action, deliberately loose payload. The hatch must refuse it (it is reserved), so
    // the only way to write this action is to satisfy the dedicated schema.
    expect(() =>
      parseEvent({
        actor_kind: 'user',
        actor_ref: 'self',
        action: 'experimental:judge_pending_attempt',
        subject_kind: 'question',
        subject_id: 'q_1',
        payload: { anything: 'goes' },
      }),
    ).toThrow();
  });
});
