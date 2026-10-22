import { ApiError, errorResponse } from '@/kernel/http';
import type { FrontdoorContext } from './context';

// Use the host's existing observation graph, including its running boss identity.
export const readStartJudgeRunStatus: FrontdoorContext['readJudgeRunStatus'] = async (runId) => {
  try {
    if (typeof runId !== 'string' || !runId) {
      throw new ApiError('validation_error', 'missing run id', 400);
    }
    const { db } = await import('@/db/client');
    const { readJudgeRunStatus } = await import('@/capabilities/practice/public');
    const read = await readJudgeRunStatus(db, runId);
    if (read.kind === 'not_found') throw new ApiError('not_found', 'judge run not found', 404);
    if (read.kind === 'unavailable') {
      throw new ApiError(
        'judge_status_unavailable',
        'judge status is temporarily unavailable',
        503,
      );
    }
    return read.value;
  } catch (error) {
    // Preserve the HTTP error shape before crossing the host/Start module boundary.
    throw errorResponse(error);
  }
};
