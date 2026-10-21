// Scheduler half of the capability registry: declaration, validation, and route
// resolution only. The real FSRS step is injected so core stays IO-free and never
// imports the server; the live review path still calls scheduleReview directly.

import type { z } from 'zod';
import type { FsrsRating, FsrsState } from '@/core/schema/business';
import type { CapabilityManifestT, JudgeResultV2T } from '@/core/schema/capability';

type FsrsStateData = z.infer<typeof FsrsState>;
type RatingLabel = z.infer<typeof FsrsRating>;

/** Structurally matches the server's ScheduleResult. */
export interface SchedulerStepResult {
  nextState: FsrsStateData;
  dueAt: Date;
}

/** Injected FSRS step; injection is what keeps this surface free of server imports. */
export type ComputeNextFn = (
  prevState: FsrsStateData | null,
  rating: RatingLabel,
  now: Date,
) => SchedulerStepResult;

export interface SchedulingInput {
  prevState: FsrsStateData | null;
  judgeResult: JudgeResultV2T;
  now: Date;
  computeNext: ComputeNextFn;
}

export interface SchedulingDecision {
  rating: RatingLabel | null;
  nextState: FsrsStateData | null;
  dueAt: Date | null;
  confidence: number;
}

export interface SchedulerCapabilityRunner {
  readonly manifest: CapabilityManifestT;
  run(input: SchedulingInput): SchedulingDecision | Promise<SchedulingDecision>;
}
