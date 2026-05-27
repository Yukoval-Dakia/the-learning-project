import type { FsrsRating } from '@/core/schema/business';
import type { JudgeResultV2T } from '@/core/schema/capability';
import type { z } from 'zod';

type CoarseOutcome = JudgeResultV2T['coarse_outcome'];
type Rating = z.infer<typeof FsrsRating>;

/**
 * YUK-56/YUK-98 — coarse judge outcomes map onto the current 3-state review UI.
 *
 * The source spec can distinguish 'easy', but this app's FsrsRating surface is
 * currently again|hard|good, so correct collapses to good.
 */
export function ratingFromCoarseOutcome(outcome: CoarseOutcome): Rating | null {
  switch (outcome) {
    case 'correct':
      return 'good';
    case 'partial':
      return 'hard';
    case 'incorrect':
      return 'again';
    case 'unsupported':
      return null;
  }
}
