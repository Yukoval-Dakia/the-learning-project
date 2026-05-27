// YUK-101 (iter2 fix F8 / F13) — tests for resolveAdviceCauseForQuestion.
//
// F8 regression: code-review against PR #163 flagged that the inlined
// `getFailureAttempts(..., { limit: 1 })` masked older-with-cause attempts
// when a newer label-less re-failure existed. These tests pin the new scan
// behavior at the helper layer so the advice + submit routes don't drift.

import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb, testDb } from '../../../tests/helpers/db';
// YUK-101 (iter2 fix F12) — shared seeders.
import { seedAttempt, seedUserCause } from '../../../tests/helpers/event-seed';
import {
  ADVICE_CAUSE_SCAN_LIMIT,
  resolveAdviceCauseForQuestion,
} from './cause-context';

describe('resolveAdviceCauseForQuestion', () => {
  beforeEach(async () => {
    await resetDb();
  });

  it('returns null when the question has no prior failure attempts', async () => {
    expect(await resolveAdviceCauseForQuestion(testDb(), 'q_unknown')).toBeNull();
  });

  it('returns the cause from the newest failure when it carries one', async () => {
    await seedAttempt({ id: 'a_newest', question_id: 'q_newest' });
    await seedUserCause({
      attempt_event_id: 'a_newest',
      primary_category: 'carelessness',
    });
    expect(await resolveAdviceCauseForQuestion(testDb(), 'q_newest')).toBe('carelessness');
  });

  // F8 — the core regression. Pre-iter2 limit:1 in advice/submit routes
  // returned the unlabeled newest attempt, dropping the explicit cause the
  // user attached to an older failure. The helper now scans the window so
  // the older cause keeps influencing the advisor until either the user
  // labels a new one or the older signal scrolls past the window.
  it('returns the OLDER cause when newer attempts have none (F8 regression)', async () => {
    // Older failure with explicit carelessness label.
    await seedAttempt({
      id: 'a_old',
      question_id: 'q_mixed',
      created_at: new Date('2026-05-20T12:00:00Z'),
    });
    await seedUserCause({
      attempt_event_id: 'a_old',
      primary_category: 'carelessness',
    });
    // Newer failure with no cause attached.
    await seedAttempt({
      id: 'a_new',
      question_id: 'q_mixed',
      created_at: new Date('2026-05-25T12:00:00Z'),
    });
    expect(await resolveAdviceCauseForQuestion(testDb(), 'q_mixed')).toBe('carelessness');
  });

  it('returns null when no recent failure within the window carries a cause', async () => {
    for (let i = 0; i < 3; i++) {
      await seedAttempt({
        id: `a_nocause_${i}`,
        question_id: 'q_nocause',
        created_at: new Date(2026, 4, 20 + i),
      });
    }
    expect(await resolveAdviceCauseForQuestion(testDb(), 'q_nocause')).toBeNull();
  });

  it('does not scan failures beyond ADVICE_CAUSE_SCAN_LIMIT', async () => {
    // Plant a labelled failure far back, then bury it under
    // ADVICE_CAUSE_SCAN_LIMIT label-less newer failures.
    await seedAttempt({
      id: 'a_buried_old',
      question_id: 'q_buried',
      created_at: new Date('2026-05-01T12:00:00Z'),
    });
    await seedUserCause({
      attempt_event_id: 'a_buried_old',
      primary_category: 'carelessness',
    });
    for (let i = 0; i < ADVICE_CAUSE_SCAN_LIMIT; i++) {
      await seedAttempt({
        id: `a_burial_${i}`,
        question_id: 'q_buried',
        created_at: new Date(2026, 4, 10 + i),
      });
    }
    // Window-capped — buried label-bearing attempt is no longer reached.
    expect(await resolveAdviceCauseForQuestion(testDb(), 'q_buried')).toBeNull();
  });
});
