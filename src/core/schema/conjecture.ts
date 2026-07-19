// Cross-capability persisted vocabulary for the conjecture probe lifecycle.
// Keep these literals in core so agency owns the writes while shell can project
// the same records without importing agency's server implementation.

/** The question.source stamped on every served conjecture probe. */
export const PROBE_QUESTION_SOURCE = 'mind_probe' as const;

/** The canonical event action that records the qualitative probe outcome. */
export const PROBE_RESULT_ACTION = 'experimental:probe_result' as const;

/**
 * The append-only event that acknowledges (dismisses) a delivered teaching-brief
 * outcome (YUK-708 / contract §4.2). Keyed by the probe_result event it acks:
 * `subject_kind='event'`, `subject_id=<probe_result event id>`. It NEVER writes
 * derived status back onto the proposal / question / result — an ack is one new
 * row; the read model treats its existence as "this outcome is done". Not reserved,
 * so it validates through the loose generic ExperimentalEvent path.
 */
export const BRIEF_ACK_ACTION = 'experimental:brief_acknowledged' as const;

/** Reader + writer cap for concurrently served, unanswered probes. */
export const MAX_CONCURRENT_ACTIVE_PROBES = 3;

/**
 * Retryable wire code returned when an accept cannot serve its probe because the
 * active-probe cap is hit; the accept rolls back and the proposal stays pending.
 */
export const PROBE_SLOTS_FULL_CODE = 'probe_slots_full' as const;
