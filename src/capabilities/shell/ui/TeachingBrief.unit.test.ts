// @vitest-environment jsdom
//
// YUK-710 (P0F/6) — the brief_seen client-side suppression must be keyed on brief_id × learner-local
// day (Asia/Shanghai), NOT brief_id alone: a tab held across midnight with the same brief on screen
// must re-report the new day's open, or that day is never counted and its action becomes unpaired.

import { describe, expect, it } from 'vitest';
import { nextBriefSeenState } from './TeachingBrief';

describe('nextBriefSeenState (YUK-710)', () => {
  it('reports once per brief × local day, re-firing exactly once when the Shanghai day rolls over', () => {
    // 2026-07-10 09:00 BJT.
    const morning = new Date('2026-07-10T01:00:00.000Z');
    // 2026-07-10 17:00 BJT — still the 10th locally.
    const evening = new Date('2026-07-10T09:00:00.000Z');
    // 2026-07-11 04:00 BJT — the NEXT Shanghai day (20:00Z + 8h rolls the date).
    const nextDay = new Date('2026-07-10T20:00:00.000Z');

    // First sighting → report.
    const s1 = nextBriefSeenState(null, 'b1', morning);
    expect(s1.report).toBe(true);

    // Same brief, same day (later instant) → suppressed, key unchanged.
    const s2 = nextBriefSeenState(s1.key, 'b1', evening);
    expect(s2.report).toBe(false);
    expect(s2.key).toBe(s1.key);

    // Same brief, NEW Shanghai day → re-fires exactly once.
    const s3 = nextBriefSeenState(s2.key, 'b1', nextDay);
    expect(s3.report).toBe(true);
    expect(s3.key).not.toBe(s1.key);

    // ...and is suppressed again for the rest of that new day.
    const s4 = nextBriefSeenState(s3.key, 'b1', new Date('2026-07-11T02:00:00.000Z'));
    expect(s4.report).toBe(false);
    expect(s4.key).toBe(s3.key);
  });

  it('reports when the brief_id changes within the same day', () => {
    const day = new Date('2026-07-10T01:00:00.000Z');
    const s1 = nextBriefSeenState(null, 'b1', day);
    const s2 = nextBriefSeenState(s1.key, 'b2', day);
    expect(s2.report).toBe(true);
  });
});
