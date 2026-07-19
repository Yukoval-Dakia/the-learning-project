import { describe, expect, it } from 'vitest';
import {
  SELECTION_MISS_REASONS,
  classifySelectionMiss,
  parseSelectionMiss,
} from './selection-miss';

describe('SelectionMiss v1', () => {
  const base = {
    subject_id: 'math',
    knowledge_id: 'kc-1',
    selection_policy_version: 'matcher-v1',
  };

  it('locks the versioned reason vocabulary', () => {
    expect(SELECTION_MISS_REASONS).toEqual([
      'NO_ALLOWED_USE_ITEM',
      'NO_NEAR_DIFFICULTY',
      'ONLY_EXPOSED_FAMILIES',
      'NO_REQUIRED_KIND',
      'NO_TRUSTED_SOURCE',
      'NO_ACCESSIBLE_ITEM',
      'NO_SCORABLE_ITEM',
      'NO_INDEPENDENT_FAMILY',
      'ONLY_QUARANTINED_ITEMS',
    ]);
  });

  it.each([
    [{ live_knowledge: false }, 'NO_ACCESSIBLE_ITEM'],
    [{ candidate_count: 0 }, 'NO_ALLOWED_USE_ITEM'],
    [{ candidate_count: 2, near_difficulty_count: 0 }, 'NO_NEAR_DIFFICULTY'],
    [{ candidate_count: 2, near_difficulty_count: 2, required_kind_count: 0 }, 'NO_REQUIRED_KIND'],
    [
      {
        candidate_count: 2,
        near_difficulty_count: 2,
        required_kind_count: 2,
        trusted_source_count: 0,
      },
      'NO_TRUSTED_SOURCE',
    ],
    [
      {
        candidate_count: 2,
        near_difficulty_count: 2,
        required_kind_count: 2,
        trusted_source_count: 2,
        accessible_count: 0,
        quarantined_count: 2,
      },
      'ONLY_QUARANTINED_ITEMS',
    ],
  ] as const)('classifies %# deterministically', (partial, reason) => {
    const miss = classifySelectionMiss(base, {
      live_knowledge: true,
      candidate_count: 1,
      near_difficulty_count: 1,
      required_kind_count: 1,
      trusted_source_count: 1,
      accessible_count: 1,
      scorable_count: 1,
      independent_family_count: null,
      exposed_family_count: null,
      quarantined_count: 0,
      ...partial,
    });

    expect(miss.reason).toBe(reason);
    expect(parseSelectionMiss(miss)).toEqual(miss);
  });

  it('rejects malformed versions', () => {
    const valid = classifySelectionMiss(base, {
      live_knowledge: true,
      candidate_count: 0,
      near_difficulty_count: 0,
      required_kind_count: 0,
      trusted_source_count: 0,
      accessible_count: 0,
      scorable_count: 0,
      independent_family_count: null,
      exposed_family_count: null,
      quarantined_count: 0,
    });
    expect(() => parseSelectionMiss({ ...valid, version: 2 })).toThrow();
  });
});
