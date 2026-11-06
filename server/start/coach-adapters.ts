// Start-side adapters for this family. `frontdoor.ts` loads this module from the API
// graph, so every adapter below runs with the initialized subject registry, config
// snapshot and database pool; each keeps its own conversion, error and deadline handling.

import type { WeeklyReportQuery } from '@/capabilities/practice/scheduling/public';
import { errorResponse } from '@/kernel/http';

export async function readStartCoachWeekly(input: WeeklyReportQuery) {
  try {
    const { db } = await import('@/db/client');
    const { loadWeeklyReview } = await import('@/capabilities/practice/scheduling/public');
    return await loadWeeklyReview(db, input);
  } catch (error) {
    throw errorResponse(error);
  }
}

export async function readStartCoachCalibration() {
  try {
    const { db } = await import('@/db/client');
    const { loadCalibrationMaturity } = await import('@/capabilities/observability/public');
    return await loadCalibrationMaturity(db);
  } catch (error) {
    throw errorResponse(error);
  }
}

export async function readStartCoachEffectiveness() {
  try {
    const { db } = await import('@/db/client');
    const { loadEffectivenessTrend } = await import('@/capabilities/observability/public');
    return await loadEffectivenessTrend(db);
  } catch (error) {
    throw errorResponse(error);
  }
}

export const coachAdapters = {
  readStartCoachCalibration,
  readStartCoachEffectiveness,
  readStartCoachWeekly,
};
