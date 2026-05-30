// T-QP (YUK-165, ADR-0014 §5) — scheduler half of the capability registry.
//
// The registry was judge-only. ADR-0014 §5 defines SchedulingPolicy as a
// registered capability so the framework knows which ActivityKinds map to which
// scheduling policy. This lane adds the minimal scheduler surface needed to
// register the existing `fsrs_question` behavior under the `fsrs` policy and to
// declare that it serves both `question` and `question_part` activity kinds.
//
// LAYERING: `src/core` must stay IO-free and must NOT import `src/server`
// (verified boundary). The one true FSRS math lives in
// `src/server/review/fsrs.ts` (`scheduleReview`). To reuse it WITHOUT inverting
// the layer boundary, the FSRS step function is dependency-INJECTED into the
// scheduler via `SchedulingInput.computeNext`. The live review path keeps calling
// `scheduleReview` directly; the registry scheduler is for declaration /
// validation / route-resolution (mirrors the steps@1 judge precedent in
// `judges/index.ts`, where server execution does not call the core registry
// runner directly). No new scheduling algorithm is invented.

import type { FsrsRating, FsrsState } from '@/core/schema/business';
import type { CapabilityManifestT, JudgeResultV2T } from '@/core/schema/capability';
import type { z } from 'zod';

type FsrsStateData = z.infer<typeof FsrsState>;
type RatingLabel = z.infer<typeof FsrsRating>;

/** Result of one FSRS step — structurally matches `ScheduleResult` in server fsrs.ts. */
export interface SchedulerStepResult {
  nextState: FsrsStateData;
  dueAt: Date;
}

/**
 * The injected, pure FSRS step. The live path passes
 * `scheduleReview` from `src/server/review/fsrs.ts`; tests can inject a stub.
 * Keeping it injected is what lets the scheduler capability live in `src/core`
 * without importing `src/server`.
 */
export type ComputeNextFn = (
  prevState: FsrsStateData | null,
  rating: RatingLabel,
  now: Date,
) => SchedulerStepResult;

export interface SchedulingInput {
  /** Prior FSRS card state for this activity, or null for a never-reviewed card. */
  prevState: FsrsStateData | null;
  /** The judge verdict whose coarse_outcome maps onto an FSRS rating. */
  judgeResult: JudgeResultV2T;
  /** Wall-clock now. */
  now: Date;
  /** Injected FSRS step (see ComputeNextFn). */
  computeNext: ComputeNextFn;
}

export interface SchedulingDecision {
  /** The rating the judge verdict mapped to, or null when unsupported. */
  rating: RatingLabel | null;
  /** Next FSRS card state, or null when the verdict could not be rated. */
  nextState: FsrsStateData | null;
  /** Next due date, or null when the verdict could not be rated. */
  dueAt: Date | null;
  /** 1 — FSRS is a deterministic algorithm. */
  confidence: number;
}

export interface SchedulerCapabilityRunner {
  readonly manifest: CapabilityManifestT;
  run(input: SchedulingInput): SchedulingDecision | Promise<SchedulingDecision>;
}
