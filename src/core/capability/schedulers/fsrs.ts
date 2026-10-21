// The registered `fsrs` policy: maps a judge outcome to a rating and delegates the
// card transition to the injected FSRS step. No FSRS math is reimplemented here, and
// core stays free of server imports. It serves questions and question parts, which
// are question rows in the live review path.

import type { z } from 'zod';
import type { FsrsRating } from '@/core/schema/business';
import type { CapabilityManifestT, JudgeResultV2T } from '@/core/schema/capability';
import { UNIVERSAL_RATING_FROM_OUTCOME } from '@/core/schema/profile-decl';
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
  supports_activity_kinds: ['question', 'question_part'],
};

/**
 * Pin the universal default mapping: this declaration surface receives no
 * SubjectProfile; the live path resolves the profile and schedules through practice.
 */
function ratingFromCoarseOutcome(outcome: JudgeResultV2T['coarse_outcome']): RatingLabel | null {
  if (outcome === 'partial_unknown') return null;
  return UNIVERSAL_RATING_FROM_OUTCOME[outcome] ?? null;
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
