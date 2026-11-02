// Generic learning_session state-machine guard (ADR-0005/0008).

import { ApiError } from '@/kernel/http';

/**
 * Throw ApiError('conflict', 409) unless `current` is one of `allowed`; on
 * return, the assertion narrows `current` to that literal union.
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
