// Cross-capability persisted vocabulary for the conjecture probe lifecycle.
// Keep these literals in core so agency owns the writes while shell can project
// the same records without importing agency's server implementation.

/** The question.source stamped on every served conjecture probe. */
export const PROBE_QUESTION_SOURCE = 'mind_probe' as const;

/** The canonical event action that records the qualitative probe outcome. */
export const PROBE_RESULT_ACTION = 'experimental:probe_result' as const;

/** Reader + writer cap for concurrently served, unanswered probes. */
export const MAX_CONCURRENT_ACTIVE_PROBES = 3;

/**
 * Retryable wire code returned when an accept cannot serve its probe because the
 * active-probe cap is hit; the accept rolls back and the proposal stays pending.
 */
export const PROBE_SLOTS_FULL_CODE = 'probe_slots_full' as const;
