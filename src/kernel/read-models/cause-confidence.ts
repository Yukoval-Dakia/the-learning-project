// One cut for every consumer that treats an agent cause as evidence.
// Below the floor the attribution model itself was not convinced, so the cause
// does not count as a full observation and does not spend a paid variant.
// User attribution has no confidence and is not passed through this predicate.

/** At or above this, an agent cause counts as one observation. */
export const CAUSE_CONFIDENCE_ACTION_FLOOR = 0.5;

export function agentCauseCountsAsObservation(confidence: number | null | undefined): boolean {
  return (
    typeof confidence === 'number' &&
    Number.isFinite(confidence) &&
    confidence >= CAUSE_CONFIDENCE_ACTION_FLOOR
  );
}
