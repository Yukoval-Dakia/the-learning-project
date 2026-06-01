// GET /api/coach/today-plan — YUK-143 (P0.4, prepare-for-redraw).
//
// Surfaces the latest DAILY Coach TodayPlan (full) + the latest WEEKLY run's
// reflection, read from the `experimental:coach_scan` event the coach_daily /
// coach_weekly handlers already persist. The YUK-169 redraw's `/coach` page
// consumes this to render Coach's evidence-grounded plan (today the page only
// shows static weekly KPI via /api/review/weekly). Read-only.
import { db } from '@/db/client';
import { errorResponse } from '@/server/http/errors';
import { getLatestCoachPlan } from '@/server/today/coach-plan';

export const runtime = 'nodejs';

export async function GET(): Promise<Response> {
  try {
    const plan = await getLatestCoachPlan(db);
    return Response.json(plan);
  } catch (err) {
    return errorResponse(err);
  }
}
