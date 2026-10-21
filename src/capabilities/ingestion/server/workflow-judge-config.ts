/**
 * WorkflowJudge auto-enroll configuration.
 *
 * Auto-enroll writes durable learning data, so it defaults OFF: every block stays
 * in human review unless the flag is explicitly true or 1. This is the opposite
 * polarity of the note-refine triggers. The review/revert surface exists and the
 * owner opted in, but the code default remains OFF per environment.
 */

import { getConfig, getConfigFlag } from '@/core/config/store';

/** Env var that gates the auto-enroll path. Default OFF (see file header). */
export const AUTO_ENROLL_FLAG = 'WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED';
/** Env var for the combined-confidence threshold. Default 0.85 (conservative). */
export const AUTO_ENROLL_THRESHOLD_FLAG = 'WORKFLOW_JUDGE_AUTO_ENROLL_THRESHOLD';
/**
 * Gates the observe-only path. Default OFF: observe still spends paid model calls
 * per block, so it needs the same explicit opt-in.
 */
export const OBSERVE_FLAG = 'WORKFLOW_JUDGE_OBSERVE_ENABLED';

/**
 * Gates student-answer grading. Default OFF and independent of the auto-enroll
 * flag: when unset, student-work detection is skipped entirely. When enabled and a
 * block has student work, the page image goes through the multimodal judge and the
 * verdict drives a graded attempt, attribution, and mastery. Opt-in because it
 * writes durable learning data.
 */
export const STUDENT_ANSWER_GRADING_FLAG = 'WORKFLOW_JUDGE_STUDENT_ANSWER_GRADING_ENABLED';

/** Conservative default threshold: high bar → most blocks go to human review. */
export const DEFAULT_AUTO_ENROLL_THRESHOLD = 0.85;

/**
 * Singleton debounce for the auto_enroll enqueue. A bare singletonKey is a no-op on
 * a standard-policy queue, so singletonSeconds is required to collapse duplicate
 * sends. Correctness does not depend on it: the per-block FOR UPDATE claim is the
 * structural guard. Kept short because extraction enqueues only once per session.
 */
export const AUTO_ENROLL_SINGLETON_SECONDS = 60;

/** Hard ceiling for paid tagging/judging work admitted by one session job. */
export const AUTO_ENROLL_MAX_BLOCKS_PER_RUN = 10;

/** Minimal env shape these readers need (a superset of NodeJS.ProcessEnv). */
export type FlagEnv = Record<string, string | undefined>;

/** True only for an enabled literal; everything else is false. Opt-in by design. */
export function autoEnrollEnabled(env: FlagEnv = process.env): boolean {
  // Pinned key: compose fixes env plus code default; DB writes are rejected with 409.
  return getConfigFlag(AUTO_ENROLL_FLAG, env);
}

/** Threshold for routing auto; defaults to 0.85 when unset or invalid, clamped to [0, 1]. */
export function autoEnrollThreshold(env: FlagEnv = process.env): number {
  // Pinned key: env beats code default; DB writes are rejected with 409. Non-finite
  // parses fall back to the code default, matching the previous clamp.
  const resolved = getConfig(AUTO_ENROLL_THRESHOLD_FLAG, env);
  if (typeof resolved !== 'number') return DEFAULT_AUTO_ENROLL_THRESHOLD;
  return Math.min(1, Math.max(0, resolved));
}

/**
 * Observe is non-mutating but not free; an absent flag preserves the hard no-op.
 */
export function observeEnabled(env: FlagEnv = process.env): boolean {
  return getConfigFlag(OBSERVE_FLAG, env);
}

/** Whether an extraction should enqueue the paid auto-enroll/observe worker. */
export function autoEnrollJobEnabled(env: FlagEnv = process.env): boolean {
  return autoEnrollEnabled(env) || observeEnabled(env);
}

/**
 * Opt-in: the grading branch writes a graded attempt and mastery, so absence keeps
 * the text-draft behavior unchanged.
 */
export function studentAnswerGradingEnabled(env: FlagEnv = process.env): boolean {
  return getConfigFlag(STUDENT_ANSWER_GRADING_FLAG, env);
}
