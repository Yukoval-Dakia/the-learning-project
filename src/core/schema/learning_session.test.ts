import { describe, expect, it } from 'vitest';
import { LearningSessionStatusByType, TutorStatus } from './learning_session';

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
