import { ApiError, errorResponse } from '@/kernel/http';
import type { FrontdoorContext } from './context';

// Bound by frontdoor so the existing operation retains the host Db/registry/native graph.
export const readStartPlacementSession: FrontdoorContext['readPlacementSession'] = async (
  sessionId,
) => {
  try {
    if (typeof sessionId !== 'string') {
      throw new ApiError('validation_error', 'session id must be a string', 400);
    }
    const { readPlacementSession } = await import('@/capabilities/practice/public');
    return await readPlacementSession(sessionId);
  } catch (error) {
    // Shape domain errors before crossing from the host into the Start bundle.
    throw errorResponse(error);
  }
};
