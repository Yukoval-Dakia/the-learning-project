import { loadWeeklyReview } from '@/capabilities/practice/server/review-weekly';
import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    return Response.json(
      await loadWeeklyReview(db, {
        days: url.searchParams.get('days') ?? undefined,
        timezone: url.searchParams.get('timezone') ?? undefined,
      }),
    );
  } catch (err) {
    return errorResponse(err);
  }
}
