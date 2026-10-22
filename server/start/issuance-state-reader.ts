import { ApiError, errorResponse } from '@/kernel/http';
import type { FrontdoorContext } from './context';

// Keep serving decisions on the host's initialized config/task registry graph.
export const readStartIssuanceState: FrontdoorContext['readIssuanceState'] = async (issuanceId) => {
  try {
    if (typeof issuanceId !== 'string' || !issuanceId) {
      throw new ApiError('validation_error', 'missing issuance id', 400);
    }
    const { db } = await import('@/db/client');
    const { getIssuanceState } = await import('@/capabilities/practice/public');
    const state = await getIssuanceState(db, issuanceId);
    if (state.issuance == null) {
      throw new ApiError('not_found', `issuance '${issuanceId}' not found`, 404);
    }
    return state;
  } catch (error) {
    // Preserve the browser ApiError/404 branch that permits the existing issuance command.
    throw errorResponse(error);
  }
};
