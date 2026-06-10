import { activeEffectiveTruth } from '@/capabilities/practice/server/effective-truth';
import { describe, expect, it } from 'vitest';
import {
  effectiveCauseCategoryForFailureAttempt,
  effectiveCauseForFailureAttempt,
} from './cause-policy';
import type { FailureAttempt } from './queries';

const now = new Date('2026-05-24T00:00:00Z');

function failure(overrides: Partial<FailureAttempt> = {}): FailureAttempt {
  return {
    attempt_event_id: 'attempt_1',
    question_id: 'q1',
    answer_md: 'wrong',
    answer_image_refs: [],
    referenced_knowledge_ids: ['k1'],
    created_at: now,
    correction_state: activeEffectiveTruth('attempt_1'),
    ...overrides,
  };
}

describe('effective cause policy', () => {
  it('uses an active user cause before agent judge attribution', () => {
    const cause = effectiveCauseForFailureAttempt(
      failure({
        user_cause: {
          user_cause_event_id: 'uc1',
          primary_category: 'memory',
          user_notes: '记错公式',
          created_at: new Date('2026-05-24T00:02:00Z'),
          correction_state: activeEffectiveTruth('uc1'),
        },
        judge: {
          judge_event_id: 'j1',
          cause: {
            primary_category: 'concept',
            secondary_categories: ['method'],
            analysis_md: 'agent analysis',
            confidence: 0.82,
          },
          referenced_knowledge_ids: ['k1'],
          created_at: new Date('2026-05-24T00:01:00Z'),
          correction_state: activeEffectiveTruth('j1'),
        },
      }),
    );

    expect(cause).toMatchObject({
      source: 'user',
      event_id: 'uc1',
      primary_category: 'memory',
      secondary_categories: [],
      user_notes: '记错公式',
      confidence: null,
    });
  });

  it('uses the agent judge when no active user cause is present', () => {
    const cause = effectiveCauseForFailureAttempt(
      failure({
        judge: {
          judge_event_id: 'j1',
          cause: {
            primary_category: 'concept',
            secondary_categories: ['method'],
            analysis_md: 'agent analysis',
            confidence: 0.82,
          },
          referenced_knowledge_ids: ['k1'],
          created_at: new Date('2026-05-24T00:01:00Z'),
          correction_state: activeEffectiveTruth('j1'),
        },
      }),
    );

    expect(cause).toMatchObject({
      source: 'agent',
      event_id: 'j1',
      primary_category: 'concept',
      secondary_categories: ['method'],
      analysis_md: 'agent analysis',
      user_notes: null,
      confidence: 0.82,
    });
  });

  it('returns null when neither user cause nor judge attribution is active', () => {
    expect(effectiveCauseForFailureAttempt(failure())).toBeNull();
    expect(effectiveCauseCategoryForFailureAttempt(failure())).toBeNull();
  });
});
