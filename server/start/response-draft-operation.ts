import { ApiError, errorResponse } from '@/kernel/http';
import type { FrontdoorContext } from './context';

// Host-bound adapter; Practice owns parsing, issuance locking, tombstones and draft epochs.
export const saveStartResponseDraft: FrontdoorContext['saveResponseDraft'] = async (input) => {
  try {
    if (typeof input?.issuanceId !== 'string') {
      throw new ApiError('validation_error', 'issuance id must be a string', 400);
    }
    const { requestResponseDraftSave } = await import('@/capabilities/practice/public');
    const { db } = await import('@/db/client');
    return await requestResponseDraftSave(db, input.issuanceId, async () => JSON.parse(input.body));
  } catch (error) {
    // The shared authenticated fetch restores the existing browser ApiError, including 409.
    throw errorResponse(error);
  }
};
