import { describe, expect, it } from 'vitest';
import {
  isLearnerVisibleKnowledgeId,
  learnerVisibleKnowledgeIds,
} from './learner-knowledge-visibility';

describe('learner knowledge visibility', () => {
  it('uses explicit fixture namespaces rather than display names', () => {
    expect(isLearnerVisibleKnowledgeId('synthetic:yuwen:fixture')).toBe(false);
    expect(isLearnerVisibleKnowledgeId('kc_yuk792_canary_20260731a')).toBe(false);
    expect(isLearnerVisibleKnowledgeId('真实节点 synthetic: in its name')).toBe(true);
  });

  it('preserves order while removing hidden namespace IDs', () => {
    expect(
      learnerVisibleKnowledgeIds([
        'k1',
        'synthetic:yuwen:fixture',
        'kc_yuk792_canary_20260731b',
        'k2',
      ]),
    ).toEqual(['k1', 'k2']);
  });
});
