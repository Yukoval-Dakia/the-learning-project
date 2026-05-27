// T-RA — RatingAdvisor (YUK-98)
//
// Source spec: docs/superpowers/specs/2026-05-22-foundation-true-closeout-design.md §6
// Driver: docs/superpowers/plans/2026-05-27-tra-rating-advisor-driver.md §1.1
//
// Pure function: JudgeResultV2 (+ optional effective cause category from
// CC-1's effectiveCauseCategoryForFailureAttempt helper) → an FsrsRating
// advisory + human-readable reason. No IO; no DB; no FSRS-kernel diff.
//
// CC-1 invariant: this module never re-derives or re-classifies a cause —
// callers MUST pass the result of effectiveCauseCategoryForFailureAttempt()
// so the cause source-of-truth stays single-owner. The advisor's only job
// is to nudge the rating bucket by ±1 step when the effective cause is
// carelessness-leaning (lean up: 0.4 stays good rather than hard) or
// conceptual-leaning (lean down: 0.4 becomes again rather than good).
//
// ABI guarantee: scheduleReview(prevState, rating, now) is untouched. The
// advisor surfaces a suggestion to the UI; the UI keeps user-override-wins.
//
// FsrsRating is the project's 3-state enum (again | hard | good). Spec §6.2
// 'easy' branches collapse to 'good' (route.ts:80-82 documents the same
// 3-state surface for the review UI today).

import type { FsrsRating } from '@/core/schema/business';
import type { JudgeResultV2T } from '@/core/schema/capability';
import type { z } from 'zod';

export type FsrsRatingT = z.infer<typeof FsrsRating>;

export interface RatingAdvice {
  /** null when the judge route is unsupported or no judge ran. */
  rating: FsrsRatingT | null;
  /** Human-readable reason — surfaced as the advisor card body text. */
  reason: string;
  /** The raw judge score used to derive the rating; null for unsupported. */
  evidence_score: number | null;
}

export interface RatingAdvisorContext {
  /**
   * The effective cause category id from
   * effectiveCauseCategoryForFailureAttempt(failure) at the call site. Pass
   * the helper output directly; do not pre-process. Subject profiles supply
   * the id namespace (physics uses 'careless' / 'concept'; generic ids
   * 'carelessness' / 'conceptual_error' are also recognised).
   */
  causeCategory?: string | null;
}

// 3-step rating ladder used for cause-driven nudges.
const RATING_LADDER: readonly FsrsRatingT[] = ['again', 'hard', 'good'] as const;

function stepRating(rating: FsrsRatingT, delta: number): FsrsRatingT {
  const idx = RATING_LADDER.indexOf(rating);
  const next = Math.max(0, Math.min(RATING_LADDER.length - 1, idx + delta));
  return RATING_LADDER[next] as FsrsRatingT;
}

/** Returns +1 for carelessness-leaning, -1 for conceptual-leaning, 0 otherwise. */
function causeLean(causeCategory: string | null | undefined): -1 | 0 | 1 {
  if (!causeCategory) return 0;
  const id = causeCategory.toLowerCase();
  // Carelessness-leaning: physics 'careless', generic 'carelessness'.
  if (id === 'careless' || id === 'carelessness') return 1;
  // Conceptual-leaning: physics 'concept', generic 'conceptual_error', any
  // 'conceptual*' id.
  if (id === 'concept' || id.startsWith('conceptual')) return -1;
  return 0;
}

/**
 * Default rating per driver §1.1 bucket map (score in [0,1]):
 *   [0.0, 0.4) → hard   (partial low — likely retry needed)
 *   [0.4, 0.7) → good   (partial mid — mostly right)
 *   [0.7, 1.0] → good   (strong; spec §6.2 easy collapses to good)
 */
function defaultPartialRating(score: number): FsrsRatingT {
  if (score < 0.4) return 'hard';
  return 'good';
}

function bucketLabel(score: number): string {
  if (score < 0.4) return '0.0–0.4';
  if (score < 0.7) return '0.4–0.7';
  return '0.7–1.0';
}

export function judgeResultToRatingAdvice(
  result: JudgeResultV2T,
  ctx: RatingAdvisorContext = {},
): RatingAdvice {
  const capabilityLabel = `${result.capability_ref.id}@${result.capability_ref.version}`;

  if (result.coarse_outcome === 'unsupported') {
    return {
      rating: null,
      reason: `${capabilityLabel} 给出 unsupported（不在判分能力内），advisory 不可用`,
      evidence_score: null,
    };
  }

  if (result.coarse_outcome === 'incorrect') {
    return {
      rating: 'again',
      reason: `${capabilityLabel} 给出 incorrect，推荐 again`,
      evidence_score: result.score,
    };
  }

  if (result.coarse_outcome === 'correct') {
    // Spec §6.2 distinguishes easy (score ≥ 0.9) from good (≥ 0.7), but the
    // project's FsrsRating is 3-state (again|hard|good) — easy collapses
    // to good. Documented intent: route.ts:80-82.
    return {
      rating: 'good',
      reason: `${capabilityLabel} 给出 correct，score ${formatScore(result.score)}，推荐 good`,
      evidence_score: result.score,
    };
  }

  // coarse_outcome === 'partial' — apply cause lean.
  const baseRating = defaultPartialRating(result.score);
  const lean = causeLean(ctx.causeCategory);
  let rating: FsrsRatingT = baseRating;
  let leanNote = '';
  if (lean === 1) {
    // Carelessness-leaning: nudge up one step. Default 'good' clamps at good.
    rating = stepRating(baseRating, 1);
    leanNote = `；cause=${ctx.causeCategory}（粗心倾向），上调一档`;
  } else if (lean === -1) {
    // Conceptual-leaning: drop two steps to express "real misunderstanding".
    // (good → again, hard → again; floor clamps at again.)
    rating = stepRating(baseRating, -2);
    leanNote = `；cause=${ctx.causeCategory}（概念错误倾向），下调两档`;
  }

  const reason = `${capabilityLabel} 给出 partial credit ${formatScore(result.score)}（bucket ${bucketLabel(result.score)}），默认推荐 ${baseRating}${leanNote}${
    rating === baseRating ? '' : ` → ${rating}`
  }`;

  return {
    rating,
    reason,
    evidence_score: result.score,
  };
}

function formatScore(score: number): string {
  return Number.isInteger(score) ? `${score}.0` : score.toFixed(2);
}
