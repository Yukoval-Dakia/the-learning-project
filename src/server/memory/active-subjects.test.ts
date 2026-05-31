// P5.2 (YUK-143) — unit coverage for the pure per-run budget selector +
// BRIEF_REFRESH_BUDGET single-source constant. No DB: selectSubjectsForRun is a
// pure sort+slice, so the >maxSubjectsPerRun top-N + defer behavior (acceptance
// §7 "per-run budget enforced", 20+ active subjects) is testable here without
// seeding 12+ real subject profiles (only wenyan/math/physics exist).

import { BRIEF_REFRESH_BUDGET } from '@/server/ai/tools/budgets';
import { describe, expect, it } from 'vitest';
import { type ActiveSubject, selectSubjectsForRun } from './active-subjects';

function makeActive(id: string, daysAgo: number): ActiveSubject {
  return {
    scopeKey: `subject:${id}`,
    subjectId: id,
    maxCreatedAt: new Date(Date.UTC(2026, 4, 31) - daysAgo * 24 * 60 * 60 * 1000),
    events: [],
  };
}

describe('BRIEF_REFRESH_BUDGET', () => {
  it('declares the spec defaults (12 subjects / 50 events) as the single source', () => {
    expect(BRIEF_REFRESH_BUDGET.maxSubjectsPerRun).toBe(12);
    expect(BRIEF_REFRESH_BUDGET.maxEventsPerBrief).toBe(50);
  });
});

describe('selectSubjectsForRun (BR-9 per-run budget)', () => {
  it('takes the top-N most-recent and defers the rest under an activity burst (20 active)', () => {
    // 20 active subjects, each more recent than the next (s0 newest).
    const active = Array.from({ length: 20 }, (_, i) => makeActive(`s${i}`, i));

    const selected = selectSubjectsForRun(active, BRIEF_REFRESH_BUDGET.maxSubjectsPerRun);

    expect(selected).toHaveLength(BRIEF_REFRESH_BUDGET.maxSubjectsPerRun);
    // Top-12 by recency are s0..s11; s12..s19 are deferred (still in `active`,
    // eligible again next run — no starvation).
    expect(selected.map((s) => s.subjectId)).toEqual(Array.from({ length: 12 }, (_, i) => `s${i}`));
  });

  it('sorts by recency DESC regardless of input order', () => {
    const active = [makeActive('old', 10), makeActive('new', 1), makeActive('mid', 5)];
    const selected = selectSubjectsForRun(active, 12);
    expect(selected.map((s) => s.subjectId)).toEqual(['new', 'mid', 'old']);
  });

  it('returns all when under the cap (no defer)', () => {
    const active = [makeActive('a', 1), makeActive('b', 2)];
    expect(selectSubjectsForRun(active, 12)).toHaveLength(2);
  });

  it('does not mutate the input array', () => {
    const active = [makeActive('a', 2), makeActive('b', 1)];
    const before = active.map((s) => s.subjectId);
    selectSubjectsForRun(active, 12);
    expect(active.map((s) => s.subjectId)).toEqual(before);
  });
});
