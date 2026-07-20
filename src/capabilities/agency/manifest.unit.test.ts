import { describe, expect, it } from 'vitest';

import { agencyCapability } from './manifest';

describe('agency scheduled jobs', () => {
  it('keeps research meeting clear of the Sunday weekly coach slot', () => {
    const handlers = agencyCapability.jobs?.handlers ?? [];
    const researchMeeting = handlers.find((handler) => handler.name === 'research_meeting_nightly');
    const weeklyCoach = handlers.find((handler) => handler.name === 'coach_weekly');

    expect(researchMeeting?.schedule).toEqual({ cron: '5 4 * * *', tz: 'Asia/Shanghai' });
    expect(weeklyCoach?.schedule).toEqual({ cron: '30 4 * * 0', tz: 'Asia/Shanghai' });
  });
});
