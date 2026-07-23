import { describe, expect, it } from 'vitest';
import { MASTERY_PROGRESS_ACTION, parseEvent } from './index';

function masteryProgressEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    actor_kind: 'system',
    actor_ref: 'mastery_progress_signal',
    action: MASTERY_PROGRESS_ACTION,
    subject_kind: 'knowledge',
    subject_id: 'knowledge_1',
    outcome: null,
    payload: {
      knowledge_id: 'knowledge_1',
      theta_delta: 0.125,
      p_learned: 0.72,
      theta_hat: 0.48,
      question_id: 'question_1',
      attempt_event_id: 'attempt_1',
      threshold_deferred: true,
    },
    caused_by_event_id: 'attempt_1',
    ...overrides,
  };
}

describe('parseEvent — experimental:mastery_progress routing', () => {
  it('parses the historical mastery progress payload and caused-by envelope', () => {
    const parsed = parseEvent(masteryProgressEnvelope());

    expect(parsed.action).toBe('experimental:mastery_progress');
    expect((parsed as { caused_by_event_id?: string }).caused_by_event_id).toBe('attempt_1');
    expect(parsed.payload).toEqual({
      knowledge_id: 'knowledge_1',
      theta_delta: 0.125,
      p_learned: 0.72,
      theta_hat: 0.48,
      question_id: 'question_1',
      attempt_event_id: 'attempt_1',
      threshold_deferred: true,
    });
  });

  it.each([
    ['string', 'attempt_1'],
    ['null', null],
    ['undefined', undefined],
  ] as const)('parses a %s caused-by envelope', (_label, causedByEventId) => {
    const envelope = masteryProgressEnvelope({ caused_by_event_id: causedByEventId });
    const { caused_by_event_id: _omitted, ...withoutCausedBy } = envelope;
    const input = causedByEventId === undefined ? withoutCausedBy : envelope;

    const parsed = parseEvent(input);

    expect(parsed.action).toBe(MASTERY_PROGRESS_ACTION);
    expect((parsed as { caused_by_event_id?: string | null }).caused_by_event_id).toBe(
      causedByEventId,
    );
  });

  it('parses historical nullable readings', () => {
    const parsed = parseEvent(
      masteryProgressEnvelope({
        payload: {
          knowledge_id: 'knowledge_1',
          theta_delta: null,
          p_learned: null,
          theta_hat: null,
          question_id: null,
          attempt_event_id: null,
          threshold_deferred: true,
        },
      }),
    );

    expect(parsed.action).toBe('experimental:mastery_progress');
  });

  it('rejects a malformed reserved mastery progress payload', () => {
    expect(() =>
      parseEvent(
        masteryProgressEnvelope({
          payload: {
            knowledge_id: 'knowledge_1',
            theta_delta: '0.125',
            p_learned: 0.72,
            theta_hat: 0.48,
            question_id: 'question_1',
            attempt_event_id: 'attempt_1',
            threshold_deferred: true,
          },
        }),
      ),
    ).toThrow();
  });

  it('keeps unrelated experimental actions on the generic fallback', () => {
    const parsed = parseEvent({
      action: 'experimental:unrelated_probe',
      payload: { arbitrary: ['shape'] },
    });

    expect(parsed).toEqual({
      action: 'experimental:unrelated_probe',
      payload: { arbitrary: ['shape'] },
    });
  });
});
