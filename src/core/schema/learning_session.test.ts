import { describe, expect, it } from 'vitest';
import {
  LearningSessionStatusByType,
  LearningSessionType,
  PlacementStatus,
  ReviewStatus,
  TutorStatus,
} from './learning_session';

describe('TutorStatus machine (YUK-193)', () => {
  it('enumerates the real solve-tutor states', () => {
    expect(TutorStatus.options).toEqual(['active', 'submitted', 'judged', 'ended', 'abandoned']);
  });

  it('no longer carries the placeholder value', () => {
    expect(TutorStatus.options).not.toContain('placeholder');
  });

  it('accepts (tutor, active) via the discriminated union', () => {
    expect(() =>
      LearningSessionStatusByType.parse({ type: 'tutor', status: 'active' }),
    ).not.toThrow();
  });

  it('accepts (tutor, judged) via the discriminated union', () => {
    expect(() =>
      LearningSessionStatusByType.parse({ type: 'tutor', status: 'judged' }),
    ).not.toThrow();
  });

  it('rejects an unknown tutor status', () => {
    expect(() =>
      LearningSessionStatusByType.parse({ type: 'tutor', status: 'placeholder' }),
    ).toThrow();
  });
});

describe('ReviewStatus machine (U5 / YUK-203 — fixes YUK-57 paused drift)', () => {
  it('includes paused (the live server already writes it)', () => {
    expect(ReviewStatus.options).toEqual(['started', 'paused', 'completed', 'abandoned']);
  });

  it('accepts (review, paused) via the discriminated union', () => {
    expect(() =>
      LearningSessionStatusByType.parse({ type: 'review', status: 'paused' }),
    ).not.toThrow();
  });

  it.each(['started', 'completed', 'abandoned'])(
    'still accepts the pre-existing (review, %s) cases',
    (status) => {
      expect(() => LearningSessionStatusByType.parse({ type: 'review', status })).not.toThrow();
    },
  );

  it('rejects an unknown review status', () => {
    expect(() => LearningSessionStatusByType.parse({ type: 'review', status: 'frozen' })).toThrow();
  });
});

describe('PlacementStatus machine (YUK-468 cold-start inc-B)', () => {
  it("'placement' is a registered learning-session type", () => {
    expect(LearningSessionType.options).toContain('placement');
  });

  it('enumerates the bounded one-shot states (no paused/reopened)', () => {
    expect(PlacementStatus.options).toEqual(['started', 'completed', 'abandoned']);
    expect(PlacementStatus.options).not.toContain('paused');
  });

  it.each(['started', 'completed', 'abandoned'])(
    'accepts (placement, %s) via the discriminated union',
    (status) => {
      expect(() => LearningSessionStatusByType.parse({ type: 'placement', status })).not.toThrow();
    },
  );

  it('rejects (placement, paused) — placement has no paused state', () => {
    expect(() =>
      LearningSessionStatusByType.parse({ type: 'placement', status: 'paused' }),
    ).toThrow();
  });

  it('rejects an unknown placement status', () => {
    expect(() =>
      LearningSessionStatusByType.parse({ type: 'placement', status: 'frozen' }),
    ).toThrow();
  });
});
