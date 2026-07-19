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

/**
 * Append-only interaction ledger events (YUK-710 / P0F/6 — teaching-brief survival
 * telemetry). Both are minimal, opt-out-of-mem0 UI-interaction rows written by
 * `src/capabilities/shell/server/teaching-brief-interactions.ts`. Like BRIEF_ACK_ACTION
 * they are NOT reserved — they validate through the loose generic ExperimentalEvent path;
 * the report reads them by action + subject (subject_kind='event', subject_id=brief_id).
 *
 * `brief_seen` records that the learner opened a delivered brief; it is idempotent per
 * brief_id × learner-local day (Asia/Shanghai) so re-render / React Query refetch / reload
 * never inflate it. `primary_action_started` records that the learner started the brief's
 * prepared action (accept_probe / answer_probe / scoped_practice); the actual decision /
 * probe_result / ack stay on their existing canonical events and are NOT re-instrumented.
 */
export const BRIEF_SEEN_ACTION = 'experimental:brief_seen' as const;
export const PRIMARY_ACTION_STARTED_ACTION = 'experimental:primary_action_started' as const;

/**
 * The prepared-action kinds a brief can start. One per actionable brief branch:
 * `accept_probe` (finding → accept the verification direction), `answer_probe`
 * (probe_ready → open the discriminating probe), `scoped_practice` (outcome_confirmed →
 * open KC-scoped practice). Retired outcomes carry only the append-only ack, which reuses
 * the existing BRIEF_ACK_ACTION event and is not re-instrumented here.
 */
export const PRIMARY_ACTION_KINDS = ['accept_probe', 'answer_probe', 'scoped_practice'] as const;
export type PrimaryActionKind = (typeof PRIMARY_ACTION_KINDS)[number];

/** The four brief states carried as metadata on a `brief_seen` ledger row. */
export const BRIEF_STATES = [
  'finding',
  'probe_ready',
  'outcome_confirmed',
  'outcome_retired',
] as const;
export type BriefState = (typeof BRIEF_STATES)[number];

/** Reader + writer cap for concurrently served, unanswered probes. */
export const MAX_CONCURRENT_ACTIVE_PROBES = 3;

/**
 * Retryable wire code returned when an accept cannot serve its probe because the
 * active-probe cap is hit; the accept rolls back and the proposal stays pending.
 */
export const PROBE_SLOTS_FULL_CODE = 'probe_slots_full' as const;
