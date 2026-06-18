// YUK-403 inc-4b — GET /api/review/drafts/[id]: full-text draft preview.
//
// Serves the owner manual gate preview pane (loom DrPreviewBody): the UNtruncated
// prompt + passage / options / answer / difficulty / knowledge for one draft. Only
// draft_status='draft' AND non-soft-archived questions are visible (same filter as
// the list); a non-draft / soft-archived / missing question → 404. Auth is enforced
// upstream by the /api/* internal-token middleware; thin shell over
// getDraftReviewDetail (the projection logic lives in server/draft-review.ts).

import { getDraftReviewDetail } from '@/capabilities/practice/server/draft-review';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/server/http/errors';

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
