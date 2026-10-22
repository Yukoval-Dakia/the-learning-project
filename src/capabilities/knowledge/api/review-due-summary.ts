import { loadReviewDueSummary } from '@/capabilities/knowledge/server/review-due-summary';
import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';

export async function GET(): Promise<Response> {
  try {
    return Response.json(await loadReviewDueSummary(db));
  } catch (err) {
    return errorResponse(err);
  }
}
