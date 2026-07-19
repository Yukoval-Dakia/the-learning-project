import { describe, expect, it } from 'vitest';
import { parseEvent } from './index';

function subjectRootNameEvent(overrides: Record<string, unknown> = {}) {
  return {
    actor_kind: 'user',
    actor_ref: 'owner',
    action: 'experimental:subject_root_name_update',
    subject_kind: 'knowledge',
    subject_id: 'seed:yuwen:root',
    outcome: 'success',
    payload: {
      control_action: 'rename',
      subject_id: 'yuwen',
      previous_name: '语文',
      next_name: '古文',
      previous_version: 0,
      next_version: 1,
    },
    ...overrides,
  };
}

describe('SubjectRootNameUpdateExperimental', () => {
  it('accepts the exact owner-driven version/name transition', () => {
    expect(parseEvent(subjectRootNameEvent())).toMatchObject({
      action: 'experimental:subject_root_name_update',
      payload: { next_name: '古文', next_version: 1 },
    });
  });

  it('rejects malformed reserved events instead of falling through the generic escape hatch', () => {
    expect(() =>
      parseEvent(
        subjectRootNameEvent({
          payload: {
            control_action: 'rename',
            subject_id: 'yuwen',
            previous_name: '语文',
            next_name: '古文',
            previous_version: 0,
            next_version: 2,
          },
        }),
      ),
    ).toThrow();
    expect(() =>
      parseEvent(subjectRootNameEvent({ actor_kind: 'agent', actor_ref: 'maintenance' })),
    ).toThrow();
  });
});
