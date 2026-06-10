import { describe, expect, it } from 'vitest';

import { ApiError } from '@/server/http/errors';
import { normalizeReviewSubmitActivityRef } from './activity-ref';

describe('normalizeReviewSubmitActivityRef', () => {
  it('uses activity_ref as the primary identity', () => {
    expect(
      normalizeReviewSubmitActivityRef({
        activity_ref: { kind: 'question', id: 'q1' },
      }),
    ).toEqual({
      activity_ref: { kind: 'question', id: 'q1' },
      question_id: 'q1',
    });
  });

  it('accepts legacy question_id during the compatibility window', () => {
    expect(normalizeReviewSubmitActivityRef({ question_id: 'q1' })).toEqual({
      activity_ref: { kind: 'question', id: 'q1' },
      question_id: 'q1',
    });
  });

  it('accepts legacy mistake_id during the compatibility window', () => {
    expect(normalizeReviewSubmitActivityRef({ mistake_id: 'q1' })).toEqual({
      activity_ref: { kind: 'question', id: 'q1' },
      question_id: 'q1',
    });
  });

  it('allows duplicate compatibility fields when all ids match', () => {
    expect(
      normalizeReviewSubmitActivityRef({
        activity_ref: { kind: 'question', id: 'q1' },
        question_id: 'q1',
        mistake_id: 'q1',
      }),
    ).toEqual({
      activity_ref: { kind: 'question', id: 'q1' },
      question_id: 'q1',
    });
  });

  it('rejects conflicting compatibility identities', () => {
    expect(() =>
      normalizeReviewSubmitActivityRef({
        activity_ref: { kind: 'question', id: 'q1' },
        question_id: 'q2',
      }),
    ).toThrow(ApiError);
  });

  it('rejects unsupported activity kinds', () => {
    expect(() =>
      normalizeReviewSubmitActivityRef({
        activity_ref: { kind: 'record', id: 'r1' },
      }),
    ).toThrow(ApiError);
  });

  it('rejects question_part (a valid ActivityKind not yet supported by review submit)', () => {
    // question_part is a real ActivityKind (ADR-0014 §1 / T-QP) but review submit
    // currently supports `question` only; it must reject, not silently coerce.
    expect(() =>
      normalizeReviewSubmitActivityRef({
        activity_ref: { kind: 'question_part', id: 'qp1' },
      }),
    ).toThrow(ApiError);
  });

  it('requires one identity field', () => {
    expect(() => normalizeReviewSubmitActivityRef({})).toThrow(ApiError);
  });
});
