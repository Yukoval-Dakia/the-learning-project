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
  // The whole point of T-QP: this policy serves plain questions AND parts.
  supports_activity_kinds: ['question', 'question_part'],
};

/**
 * YUK-739 — coarse judge outcome → FSRS rating. The duplicated inline switch
 * is gone; the mapping is the subject-owned rating policy's universal default,
 * exported from `src/core/schema/profile-decl.ts`
 * (`UNIVERSAL_RATING_FROM_OUTCOME`). This scheduler capability deliberately
 * receives no SubjectProfile (ADR-0014 §5: declaration/validation surface; the
 * live path schedules via the practice route, which resolves the profile), so
 * it pins the tracked universal constant — same values, one source of truth.
 */
function ratingFromCoarseOutcome(outcome: JudgeResultV2T['coarse_outcome']): RatingLabel | null {
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
