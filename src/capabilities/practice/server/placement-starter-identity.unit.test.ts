import {
  placementStarterAttemptId,
  placementStarterIdentity,
} from '@/server/question-supply/placement-starter-identity';
import { describe, expect, it } from 'vitest';

const REVISION = 'evt_goal_semantic_1';

describe('placement starter identity', () => {
  it('is stable for a semantic revision and subject', () => {
    expect(placementStarterIdentity(REVISION, 'math')).toEqual(
      placementStarterIdentity(REVISION, 'math'),
    );
  });

  it('changes only when semantic authority or subject changes', () => {
    const base = placementStarterIdentity(REVISION, 'math');
    expect(placementStarterIdentity('evt_goal_semantic_2', 'math').claimId).not.toBe(base.claimId);
    expect(placementStarterIdentity(REVISION, 'physics').claimId).not.toBe(base.claimId);
  });

  it('derives one attempt identity per delivery', () => {
    const ids = [1, 2, 3].map((delivery) => placementStarterAttemptId('claim', 'job', delivery));
    expect(new Set(ids).size).toBe(3);
    expect(placementStarterAttemptId('claim', 'job', 1)).toBe(ids[0]);
  });
});
