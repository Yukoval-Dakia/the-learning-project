import { ApiError, errorResponse } from '@/kernel/http';
import type { FrontdoorContext } from './context';

export const selectStartPlacementQuestion: FrontdoorContext['selectNextPlacementQuestion'] = async (
  sessionId,
) => {
  try {
    if (typeof sessionId !== 'string') {
      throw new ApiError('validation_error', 'session id must be a string', 400);
    }
    const { db } = await import('@/db/client');
    const { selectNextPlacementQuestion } = await import('@/capabilities/practice/public');
    // The live placement client sends an empty body; scope and policy stay server-owned.
    return await selectNextPlacementQuestion(db, sessionId, {});
  } catch (error) {
    throw errorResponse(error);
  }
};
