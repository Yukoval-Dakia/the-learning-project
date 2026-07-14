import { describe, expect, it } from 'vitest';
import { weeklyReviewPath } from './coach-weekly';

describe('weeklyReviewPath', () => {
  it('sends the browser time zone as an explicit API contract', () => {
    expect(weeklyReviewPath(7, 'America/New_York')).toBe(
      '/api/review/weekly?days=7&timezone=America%2FNew_York',
    );
  });
});
