import { ActivityKind, ActivityRef } from '@/core/schema/activity';
import { describe, expect, it } from 'vitest';

describe('ActivityKind', () => {
  it('accepts all defined activity kinds', () => {
    for (const kind of [
      'question',
      'question_part',
      'record',
      'recall_prompt',
      'practice_log',
      'project_milestone',
      'open_inquiry',
    ]) {
      expect(ActivityKind.safeParse(kind).success).toBe(true);
    }
  });

  it('rejects unknown kinds', () => {
    expect(ActivityKind.safeParse('quiz').success).toBe(false);
    expect(ActivityKind.safeParse('').success).toBe(false);
  });
});

describe('ActivityRef', () => {
  it('accepts valid ref with question kind', () => {
    const result = ActivityRef.safeParse({ kind: 'question', id: 'q_abc123' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe('question');
      expect(result.data.id).toBe('q_abc123');
    }
  });

  it('accepts valid ref with record kind', () => {
    const result = ActivityRef.safeParse({ kind: 'record', id: 'rec_xyz' });
    expect(result.success).toBe(true);
  });

  it('rejects ref with unknown kind', () => {
    expect(ActivityRef.safeParse({ kind: 'quiz', id: 'q_1' }).success).toBe(
      false,
    );
  });

  it('rejects ref without id', () => {
    expect(ActivityRef.safeParse({ kind: 'question' }).success).toBe(false);
  });

  it('rejects ref with empty id', () => {
    expect(ActivityRef.safeParse({ kind: 'question', id: '' }).success).toBe(
      false,
    );
  });
});
