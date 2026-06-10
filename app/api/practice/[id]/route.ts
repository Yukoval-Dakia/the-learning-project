// U5 (YUK-203, §4.10 Q8-addendum) — GET /api/practice/[id]: full answering-page
// payload for one paper artifact. Discovered plan gap during UI lane integration:
// the four existing practice endpoints return zero question-face content, making
// the answering page impossible to render. Orchestrator ruling: addendum owned by
// L-paper-core (additive, zero contract change to the existing four endpoints).
//
// Returns: paper meta + ordered sections + per-slot question face + live draft
// (for answer restoration on page reload) + submission state with SERVER-gated
// visibility (§4.9: score/outcome withheld when visible_to_user:false and session
// not yet 'completed').
//
// One aggregation call — no N+1 per-slot fetch (Q8 principle).

import { getPaperDetail } from '@/capabilities/practice/server/paper-detail';
import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/server/http/errors';

export const runtime = 'nodejs';

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id: paperArtifactId } = await params;
    const result = await getPaperDetail(db, paperArtifactId);
    if (!result) {
      throw new ApiError('not_found', `paper artifact ${paperArtifactId} not found`, 404);
    }
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
