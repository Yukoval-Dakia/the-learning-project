// U5 (YUK-203, §4.10 Q8-addendum) — GET /api/practice/[id]: full answering-page
// payload for one paper artifact.（P2a 迁入包；M2-T7 起仅由 Hono manifest 挂载。）
//
// Returns: paper meta + ordered sections + per-slot question face + live draft
// (for answer restoration on page reload) + submission state with SERVER-gated
// visibility (§4.9: score/outcome withheld when visible_to_user:false and session
// not yet 'completed').
//
// One aggregation call — no N+1 per-slot fetch (Q8 principle).

import { db } from '@/db/client';
import { ApiError, errorResponse } from '@/kernel/http';
import { getPaperDetail } from '../server/paper-detail';

export async function GET(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    const { id: paperArtifactId } = params;
    const result = await getPaperDetail(db, paperArtifactId);
    if (!result) {
      throw new ApiError('not_found', `paper artifact ${paperArtifactId} not found`, 404);
    }
    return Response.json(result);
  } catch (err) {
    return errorResponse(err);
  }
}
