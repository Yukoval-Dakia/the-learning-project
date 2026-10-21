// GET /api/papers/[id]: full answering-page payload for one paper artifact.
//
// Returns paper meta, ordered sections, per-slot question face, live draft (for
// answer restoration on reload), and submission state. Score/outcome stay hidden
// while visible_to_user is false and the session is not yet 'completed'.
//
// One aggregation call — no per-slot N+1 fetch.

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
