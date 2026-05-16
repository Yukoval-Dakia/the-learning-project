import { describe, expect, it } from 'vitest';

import { ApiError } from '@/server/http/errors';
import { assertFromState } from './guards';

describe('assertFromState (generic)', () => {
  it('silently passes when current is in allowed', () => {
    expect(() =>
      assertFromState('queued', ['queued', 'uploaded'] as const, 'sess_1', 'enqueue'),
    ).not.toThrow();
  });

  it('throws ApiError conflict (409) when current is not allowed', () => {
    try {
      assertFromState('extracting', ['queued', 'uploaded'] as const, 'sess_2', 'enqueue');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe('conflict');
      expect((err as ApiError).status).toBe(409);
      expect((err as ApiError).message).toContain('sess_2');
      expect((err as ApiError).message).toContain("status 'extracting'");
      expect((err as ApiError).message).toContain('queued, uploaded');
      expect((err as ApiError).message).toContain('enqueue');
    }
  });

  it('works for different status enums (review status)', () => {
    expect(() =>
      assertFromState('started', ['started'] as const, 'sess_3', 'completeReviewSession'),
    ).not.toThrow();
    expect(() =>
      assertFromState('completed', ['started'] as const, 'sess_4', 'completeReviewSession'),
    ).toThrow(ApiError);
  });

  it('type-narrows current to the allowed union after assertion', () => {
    type IngestionStatus = 'uploaded' | 'queued';
    const current: string = 'queued';
    assertFromState(current, ['uploaded', 'queued'] as const, 'sess_5', 'demo');
    // After assertion, TS narrows current to 'uploaded' | 'queued'
    const narrowed: IngestionStatus = current;
    expect(narrowed).toBe('queued');
  });
});
