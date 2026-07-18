import { describe, expect, it } from 'vitest';
import { buildSessionTransitionRequest } from './session-transition';

describe('buildSessionTransitionRequest (YUK-211)', () => {
  it('builds the normal idempotent target-state PATCH', () => {
    expect(buildSessionTransitionRequest('completed')).toEqual({
      method: 'PATCH',
      body: JSON.stringify({ status: 'completed' }),
    });
  });

  it('opts pagehide requests into browser keepalive delivery', () => {
    expect(buildSessionTransitionRequest('paused', { keepalive: true })).toEqual({
      method: 'PATCH',
      body: JSON.stringify({ status: 'paused' }),
      keepalive: true,
    });
  });
});
