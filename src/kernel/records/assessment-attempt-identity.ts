// Native attempt anchor identity: the event primary key `evt_assessment_<submission_id>`.
// The submission id is appended verbatim (no encoding): capture idempotency, the
// attempt-capture advisory lock and settlement replay all look the row up by this id.

const ASSESSMENT_ATTEMPT_EVENT_ID_PREFIX = 'evt_assessment_';

export function assessmentAttemptEventId(submissionId: string): string {
  return `${ASSESSMENT_ATTEMPT_EVENT_ID_PREFIX}${submissionId}`;
}

/** Submission id of a native attempt anchor id; null for any other event id. */
export function submissionIdFromAttemptEventId(eventId: string): string | null {
  return eventId.startsWith(ASSESSMENT_ATTEMPT_EVENT_ID_PREFIX)
    ? eventId.slice(ASSESSMENT_ATTEMPT_EVENT_ID_PREFIX.length)
    : null;
}
