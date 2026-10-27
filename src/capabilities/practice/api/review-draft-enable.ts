// POST /api/review/drafts/[id]/enable: owner manual gate, normal verify → promote.
//
// verifyAndPromote reuses the per-source quiz_verify/source_verify handler and
// promotes on pass; otherwise it returns the tri-state verdict
// (needs_review / failed + reason). actor='user' marks the verify event as
// owner-driven. Auth is enforced upstream by the /api/* internal-token middleware.

import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { enablePracticeDraft } from '../server/draft-promotion-operations';

export async function POST(_req: Request, params: Record<string, string>): Promise<Response> {
  try {
    return Response.json(await enablePracticeDraft(db, params));
  } catch (err) {
    return errorResponse(err);
  }
}
