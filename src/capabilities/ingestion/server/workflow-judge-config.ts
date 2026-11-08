/**
 * WorkflowJudge auto-enroll configuration.
 *
 * Auto-enroll has no off switch (Owner: "收进题库要的是自动"); it always runs paid
 * tagging and enrollment after extraction. Its enrolments stay revertable through the
 * review surface. Student-answer grading remains a separate opt-in.
 */

import { getConfigFlag } from '@/core/config/store';

/**
 * Singleton debounce for the auto_enroll enqueue. A bare singletonKey is a no-op on
 * a standard-policy queue, so singletonSeconds is required to collapse duplicate
 * sends. Correctness does not depend on it: the per-block FOR UPDATE claim is the
 * structural guard. Kept short because extraction enqueues only once per session.
 */
export const AUTO_ENROLL_SINGLETON_SECONDS = 60;

/** Hard ceiling for paid tagging/judgment work admitted by one session delivery. */
export const AUTO_ENROLL_MAX_BLOCKS_PER_RUN = 10;

/**
 * Gates student-answer grading. Default OFF and out of scope for the auto-enroll
 * slice: when unset, student-work grading stays off entirely. Opt-in because it
 * writes durable learning data.
 */
export const STUDENT_ANSWER_GRADING_FLAG = 'WORKFLOW_JUDGE_STUDENT_ANSWER_GRADING_ENABLED';

/** Minimal env shape these readers need (a superset of NodeJS.ProcessEnv). */
export type FlagEnv = Record<string, string | undefined>;

/**
 * Opt-in: the grading branch writes a graded attempt and mastery, so absence keeps
 * the text-draft behavior unchanged.
 */
export function studentAnswerGradingEnabled(env: FlagEnv = process.env): boolean {
  return getConfigFlag(STUDENT_ANSWER_GRADING_FLAG, env);
}
