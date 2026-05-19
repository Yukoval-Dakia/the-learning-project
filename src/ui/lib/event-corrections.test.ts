import { describe, expect, it } from 'vitest';
import { affectedRefsForCorrection } from './event-corrections';

describe('affectedRefsForCorrection', () => {
  it('uses the focal activity ref when the event subject is an activity kind', () => {
    expect(
      affectedRefsForCorrection({
        subject_kind: 'question',
        subject_id: 'q1',
      }),
    ).toEqual([{ kind: 'question', id: 'q1' }]);
  });

  it('does not infer a parent activity ref for non-activity focal events', () => {
    expect(
      affectedRefsForCorrection({
        subject_kind: 'event',
        subject_id: 'evt_judge',
      }),
    ).toEqual([]);
  });
});
