// YUK-101 (iter2 fix F8 / F13) — RatingAdvisor cause-context helper.
//
// Code-review against PR #163 (YUK-99 / YUK-100) surfaced two related issues:
//
// * F13 — `app/api/review/advice/route.ts` and `app/api/review/submit/route.ts`
//   each inlined the same dance:
//     getFailureAttempts(db, { questionIds: [id], limit: 1 })
//       → effectiveCauseCategoryForFailureAttempt(newest)
//   so any future tweak (e.g. F8 below) had to land twice.
//
// * F8 — `limit: 1` reads only the newest failure. When the user labels an
//   earlier failure as carelessness and later re-fails the same question
//   without attaching a cause, the unlabeled newest masks the older signal
//   and the advisor falls back to the default partial-credit bucket — the
//   explicit user-recorded cause is silently dropped.
//
// This module owns the read policy so the routes don't have to. It scans
// the most recent ADVICE_CAUSE_SCAN_LIMIT active failures (newest first)
// and returns the FIRST non-null effective cause. Returns null when no
// recent failure within the window carries any cause (legal fallback —
// the advisor keeps the default bucket).
//
// CC-1 invariant: this module performs no cause classification. It only
// folds `effectiveCauseCategoryForFailureAttempt` over the recent failure
// window. The advisor — `judgeResultToRatingAdvice` — also classifies
// nothing; together they remain single-owner consumers of the cause SoT.

import type { CauseCategoryT } from '@/core/schema/event/blocks';
import { effectiveCauseCategoryForFailureAttempt } from '@/server/events/cause-policy';
import { getFailureAttempts } from '@/server/events/queries';

/**
 * The window we scan for a cause-bearing prior failure. Five attempts is
 * deep enough to survive a few label-less re-failures after the user
 * explicitly labelled a cause, and shallow enough that very old causes
 * (long-since-resolved learning) don't keep nudging the advisor.
 */
export const ADVICE_CAUSE_SCAN_LIMIT = 5;

type Db = Parameters<typeof getFailureAttempts>[0];

/**
 * Resolve the effective cause for the RatingAdvisor on `questionId`.
 *
 * @returns The first non-null `effectiveCauseCategoryForFailureAttempt`
 *   across the most recent {@link ADVICE_CAUSE_SCAN_LIMIT} active failure
 *   attempts on this question (newest first). `null` when no recent
 *   failure within the window has a cause attached.
 */
export async function resolveAdviceCauseForQuestion(
  db: Db,
  questionId: string,
): Promise<CauseCategoryT | null> {
  const recentFailures = await getFailureAttempts(db, {
    questionIds: [questionId],
    limit: ADVICE_CAUSE_SCAN_LIMIT,
  });
  for (const failure of recentFailures) {
    const cause = effectiveCauseCategoryForFailureAttempt(failure);
    if (cause !== null) return cause;
  }
  return null;
}
