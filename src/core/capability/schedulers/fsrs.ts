// T-QP (YUK-165, ADR-0014 §5) — the `fsrs` scheduling policy as a registered
// capability. This is the EXISTING `fsrs_question` behavior, generalized to
// declare it serves both `question` and `question_part` activity kinds. It does
// NOT reimplement FSRS: `run()` maps the judge's coarse_outcome onto an FSRS
// rating (reusing `ratingFromCoarseOutcome`'s mapping — kept inline here so core
// stays free of any server import) and delegates the actual card transition to
// the injected `computeNext` (the live path passes `scheduleReview` from
// `src/server/review/fsrs.ts`). Same math, one source of truth.
//
// Because a `question_part` IS a `question` row, the live review/due path already
// schedules parts via this exact policy with subject_kind='question'. This
// capability makes that mapping explicit + registry-visible (per ADR-0014 §5) and
// lets validateProfile assert `schedulingHints.default_policy` resolves here.

import type { FsrsRating } from '@/core/schema/business';
import type { CapabilityManifestT, JudgeResultV2T } from '@/core/schema/capability';
import type { z } from 'zod';
import type { SchedulerCapabilityRunner, SchedulingDecision, SchedulingInput } from './types';

type RatingLabel = z.infer<typeof FsrsRating>;

const VERSION = '1.0.0';

const manifest: CapabilityManifestT = {
  id: 'fsrs',
  kind: 'scheduler',
  version: VERSION,
  input_schema: 'SchedulingInput { prevState, judgeResult, now, computeNext }',
  output_schema: 'SchedulingDecision { rating, nextState, dueAt, confidence }',
  cost_class: 'local',
  latency_class: 'sync',
  stability: 'stable',
  // The whole point of T-QP: this policy serves plain questions AND parts.
  supports_activity_kinds: ['question', 'question_part'],
};

/**
 * Coarse judge outcome → FSRS rating. Identical mapping to
 * `src/server/review/judge-rating.ts#ratingFromCoarseOutcome`; duplicated as a
 * pure function here so the core capability never imports `src/server`. If the
 * rating surface changes, both must change together (single 3-state surface today).
 */
function ratingFromCoarseOutcome(outcome: JudgeResultV2T['coarse_outcome']): RatingLabel | null {
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

function run(input: SchedulingInput): SchedulingDecision {
  const rating = ratingFromCoarseOutcome(input.judgeResult.coarse_outcome);
  if (rating === null) {
    return { rating: null, nextState: null, dueAt: null, confidence: 1 };
  }
  const step = input.computeNext(input.prevState, rating, input.now);
  return {
    rating,
    nextState: step.nextState,
    dueAt: step.dueAt,
    confidence: 1,
  };
}

export const fsrsSchedulerCapability: SchedulerCapabilityRunner = { manifest, run };
