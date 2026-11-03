import { errorResponse } from '@/kernel/http';
import type { FrontdoorContext } from './context';

// Keep model-pin and admission reads in the initialized host graph. Practice owns parsing,
// locking, frozen bindings, claims and replay; the caller supplies no actor or time.
export const createStartIssuance: FrontdoorContext['createIssuance'] = async (body) => {
  try {
    const { requestAssessmentIssuance } = await import('@/capabilities/practice/public');
    const { db } = await import('@/db/client');
    return await requestAssessmentIssuance(db, async () => JSON.parse(body));
  } catch (error) {
    throw errorResponse(error);
  }
};
