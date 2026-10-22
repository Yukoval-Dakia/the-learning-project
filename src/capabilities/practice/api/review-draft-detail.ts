// GET /api/review/drafts/[id]: full-text draft preview for the owner manual gate.
//
// Only draft_status='draft' and non-soft-archived questions are visible (same
// filter as the list); anything else 404s. Auth is enforced upstream by the
// /api/* internal-token middleware. Projection logic lives in
// server/draft-review.ts.

import { getDraftReviewDetail } from '@/capabilities/practice/server/draft-review';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';

export async function GET(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const id = (params.id ?? '').trim();
    if (!id) {
      throw new ApiError('validation_error', 'question id is required', 400);
    }

    const detail = await getDraftReviewDetail(db, id);
    if (!detail) {
      throw new ApiError('not_found', `draft ${id} not found`, 404);
    }

    return Response.json(detail);
  } catch (err) {
    return errorResponse(err);
  }
}
