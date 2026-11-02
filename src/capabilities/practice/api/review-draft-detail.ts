// GET /api/review/drafts/[id]: full-text draft preview for the owner manual gate.
//
// Only draft_status='draft' and non-soft-archived questions are visible (same
// filter as the list); anything else 404s. Auth is enforced upstream by the
// /api/* internal-token middleware. Projection logic lives in
// server/draft-review.ts.

import { readDraftReviewDetail } from '@/capabilities/practice/server/draft-review';
import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';

export async function GET(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const detail = await readDraftReviewDetail(db, params.id);

    return Response.json(detail);
  } catch (err) {
    return errorResponse(err);
  }
}
