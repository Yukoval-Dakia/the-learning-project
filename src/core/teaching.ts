// P5.6 / YUK-178 — TeachingDrawer corrective-chip trigger (cross-subject, no IO).
//
// LD-3 / §4.3: the drawer's redo / revisit-prerequisite chip becomes
// `corrective` once the active question's CUMULATIVE attempt failure total
// reaches N. `attempt_counts.failure` is a cumulative sum over the whole
// question timeline (context-readers.ts ~:599-:604), NOT a consecutive-failure
// streak — so the trigger is "total failures >= N", not "still failing now".
// Consecutive-failure is a future refinement requiring a new attempt-stream
// query (§12 open item 2); it is NOT claimed here.

/**
 * P5.6 single-source tunable: total failures on the active question at which a
 * teaching-drawer redo chip flips from `proactive` to `corrective` (§4.3, SK-4).
 * N = 3 — three failures is where "try again" stops being normal practice and
 * becomes "this prerequisite is not landing". Tunable after real session logs
 * (mirrors P5.1's "tune after ~2 weeks" stance). Keep this the ONLY definition
 * of the constant so the UI helper and any future server reader agree.
 */
export const TEACHING_CORRECTIVE_FAILURE_N = 3;

/**
 * Pure trigger for AC-4: does the cumulative failure total warrant a corrective
 * redo chip? `>= N` (total, not consecutive — §4.3). Absence of a count (the
 * question-creation turn, no attempts yet) is `false` (proactive).
 */
export function isCorrectiveRedo(failureCount: number | null | undefined): boolean {
  return (failureCount ?? 0) >= TEACHING_CORRECTIVE_FAILURE_N;
}
