import { describe, expect, expectTypeOf, it } from 'vitest';

import * as Session from '.';
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
      'ingestion' | 'review' | 'tutor' | 'explore' | 'create' | 'conversation' | 'placement'
    >();
  });
});

describe('session barrel — Tutor (YUK-193)', () => {
  it('re-exports the Tutor namespace with the transition functions', () => {
    expect(typeof Session.Tutor.startTutorSession).toBe('function');
    expect(typeof Session.Tutor.markSubmitted).toBe('function');
    expect(typeof Session.Tutor.markJudged).toBe('function');
    expect(typeof Session.Tutor.endTutor).toBe('function');
  });
});

describe('session barrel — Placement (YUK-468)', () => {
  it('re-exports the Placement namespace with the transition functions', () => {
    expect(typeof Session.Placement.startPlacementSession).toBe('function');
    expect(typeof Session.Placement.completePlacementSession).toBe('function');
    expect(typeof Session.Placement.abandonPlacementSession).toBe('function');
  });
});
