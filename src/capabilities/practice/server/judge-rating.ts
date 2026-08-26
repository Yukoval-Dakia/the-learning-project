import type { z } from 'zod';
import type { FsrsRating } from '@/core/schema/business';
import type { JudgeResultV2T } from '@/core/schema/capability';
import {
  type RatingFromOutcomePolicyT,
  type RatingPolicyProfileLike,
  ratingFromOutcomeFor,
} from '@/core/schema/profile-decl';

type CoarseOutcome = JudgeResultV2T['coarse_outcome'];
type Rating = z.infer<typeof FsrsRating>;

/**
 * YUK-56/YUK-98 — coarse judge outcomes map onto the current 3-state review UI.
 *
 * YUK-739 — the mapping is subject-owned policy: with a SubjectProfile in
 * scope, the verdict → rating map resolves through the profile's
 * `ratingPolicy.outcomeToRating` section (every built-in declares the
 * universal correct→good / partial→hard / incorrect→again / unsupported→null
 * mapping, so behavior is unchanged for them). Without a profile the
 * genuinely-universal map applies — the single tracked fallback, no local
 * mirror. The source spec can distinguish 'easy', but this app's FsrsRating
 * surface is currently again|hard|good, so correct collapses to good.
 */
export function ratingFromCoarseOutcome(
  outcome: CoarseOutcome,
  subjectProfile?: RatingPolicyProfileLike | null,
): Rating | null {
  const policy: RatingFromOutcomePolicyT = ratingFromOutcomeFor(subjectProfile);
  return policy[outcome] ?? null;
}
