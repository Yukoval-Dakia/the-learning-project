import type { WeeklyReportQuery } from '@/capabilities/practice/public';
import { errorResponse } from '@/kernel/http';

export async function readStartCoachWeekly(input: WeeklyReportQuery) {
  try {
    const { db } = await import('@/db/client');
    const { loadWeeklyReview } = await import('@/capabilities/practice/public');
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
