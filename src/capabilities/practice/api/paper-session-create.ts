// Compatibility residual (YUK-1570): the paper review-session creation
// operation moved to server/session-operations/review-session.ts. The export
// stays on this path because test fixtures and api/papers-list.ts import it
// here — no copied implementation.
export type { PaperReviewSessionResult } from '../server/session-operations/review-session';
export { createPaperReviewSession } from '../server/session-operations/review-session';
