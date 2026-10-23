import { errorResponse } from '@/kernel/http';
import type { FrontdoorContext } from './context';

// Bound by the initialized host graph so scope resolution and optional native
// priors use the same hydrated registry and loader state as the HTTP reader.
export const readStartPlacementProfile: FrontdoorContext['readPlacementProfile'] = async (
  goalId,
) => {
  try {
    const { db } = await import('@/db/client');
    const { readPlacementProfile } = await import('@/capabilities/practice/public');
    return await readPlacementProfile(db, goalId);
  } catch (error) {
    // Convert domain errors before crossing from the host into the Start bundle.
    throw errorResponse(error);
  }
};
