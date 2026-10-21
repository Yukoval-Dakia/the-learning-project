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
