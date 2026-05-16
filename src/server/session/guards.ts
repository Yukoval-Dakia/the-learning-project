// Phase 1c.1 Step 5 — generic state-machine guard helper (ADR-0005 single-owner
// invariant, extended to all session types per ADR-0008).
//
// Lifted from src/server/ingestion/session.ts and generalised over the status
// enum string union. Same conflict-throwing semantics; the type assertion narrows
// the input to the allowed literal-union after the throw is skipped.

import { ApiError } from '@/server/http/errors';

/**
 * Asserts that `current` is one of the `allowed` states; throws ApiError('conflict', 409)
 * otherwise. Generic over the session-type-specific status enum.
 *
 * Usage from a transition fn:
 * ```
 * assertFromState(row.status, ['uploaded', 'failed'] as const, sessionId, 'enqueueExtraction');
 * ```
 */
export function assertFromState<S extends string>(
  current: string,
  allowed: readonly S[],
  sessionId: string,
  transition: string,
): asserts current is S {
  if (!(allowed as readonly string[]).includes(current)) {
    throw new ApiError(
      'conflict',
      `LearningSession.${transition}: session ${sessionId} is in status '${current}', expected one of [${allowed.join(', ')}]`,
      409,
    );
  }
}
