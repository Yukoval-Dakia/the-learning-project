// POST /api/review/drafts/[id]/force-enable: owner manual gate override (skip
// verify, promote).
//
// Owner force-enable: skip the AI verify and promote directly, evidence-first —
// requires a non-empty `reason` (留痕). verifyAndPromote's override branch writes
// actor_kind:'user' + skipped_verify:true + reason and enforces the B-section
// guards (only raw-pool-promotable sources / true drafts / non-archived KC /
// non-soft-archived drafts may be force-promoted). Auth is enforced upstream by the
// /api/* internal-token middleware.

import { db } from '@/db/client';
import { errorResponse } from '@/kernel/http';
import { forceEnablePracticeDraft } from '../server/draft-promotion-operations';

export async function POST(req: Request, params: Record<string, string>): Promise<Response> {
  try {
    return Response.json(await forceEnablePracticeDraft(db, params, () => req.json()));
  } catch (err) {
    return errorResponse(err);
  }
}
