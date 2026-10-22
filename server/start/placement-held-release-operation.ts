import { ApiError, errorResponse } from '@/kernel/http';
import type { FrontdoorContext } from './context';

export const releaseStartHeldPlacement: FrontdoorContext['releaseHeldPlacement'] = async (
  input,
) => {
  try {
    if (typeof input?.sessionId !== 'string') {
      throw new ApiError('validation_error', 'session id must be a string', 400);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(input.body);
    } catch {
      throw new ApiError('validation_error', 'request body must be valid JSON', 400);
    }
    const { db } = await import('@/db/client');
    const { releaseHeldPlacement } = await import('@/capabilities/practice/public');
    return await releaseHeldPlacement(db, input.sessionId, raw);
  } catch (error) {
    // Shape the original errors in the host, including the UI's not_releasable branch.
    throw errorResponse(error);
  }
};
