/**
 * WorkflowJudge auto-enroll configuration.
 *
 * Auto-enroll is on by default and runs paid tagging and judging after extraction. Its
 * enrolments stay revertable through the review surface. Set the flag to false or 0, or
 * switch it off in /admin/config, to keep every block in human review. The judge
 * confidence is stored as a signal; there is no confidence threshold gate.
 */

import { getConfigFlag } from '@/core/config/store';

/** Env var that gates the auto-enroll path. Default on (see file header). */
export const AUTO_ENROLL_FLAG = 'WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED';
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

export function autoEnrollEnabled(env: FlagEnv = process.env): boolean {
  return getConfigFlag(AUTO_ENROLL_FLAG, env);
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
