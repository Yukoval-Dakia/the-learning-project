import { describe, expect, expectTypeOf, it } from 'vitest';

import { Ingestion, Review } from '.';
import type { LearningSessionTypeT } from '.';

describe('src/server/session index', () => {
  it('re-exports Ingestion namespace with expected transitions', () => {
    expect(typeof Ingestion.initiateUpload).toBe('function');
    expect(typeof Ingestion.enqueueExtraction).toBe('function');
    expect(typeof Ingestion.markExtractionStarted).toBe('function');
    expect(typeof Ingestion.applyExtractionResult).toBe('function');
    expect(typeof Ingestion.markExtractionFailed).toBe('function');
    expect(typeof Ingestion.applyRescue).toBe('function');
    expect(typeof Ingestion.markReviewed).toBe('function');
    expect(typeof Ingestion.commitImport).toBe('function');
  });

  it('re-exports Review namespace with three transitions', () => {
    expect(typeof Review.startReviewSession).toBe('function');
    expect(typeof Review.completeReviewSession).toBe('function');
    expect(typeof Review.abandonReviewSession).toBe('function');
  });

  it('re-exports LearningSessionTypeT type', () => {
    expectTypeOf<LearningSessionTypeT>().toEqualTypeOf<
      'ingestion' | 'review' | 'tutor' | 'explore' | 'create' | 'conversation'
    >();
  });
});
